import type { DraftStorage } from '../application/ports';
import { contentOf, DraftFailure, object, replyOf, sameOwner, uuid, versionOf, type DraftCommand, type DraftEntry, type DraftOwner } from '../domain/draft';

export interface DraftCustody {
  available(): Promise<boolean>;
  authenticate(): Promise<void>;
  installationId(): Promise<string>;
  readMeta(): Promise<string | null>;
  writeMeta(value: string): Promise<void>;
  removeMeta(): Promise<void>;
  readDiscard(): Promise<boolean>;
  writeDiscard(): Promise<void>;
  removeDiscard(): Promise<void>;
  readBlob(id: string): Promise<Uint8Array>;
  writeBlob(id: string, bytes: Uint8Array): Promise<void>;
  removeBlobs(except?: string): Promise<void>;
  seal(bytes: Uint8Array, aad: Uint8Array): Promise<{ bytes: Uint8Array; key: string }>;
  unseal(bytes: Uint8Array, key: string, aad: Uint8Array): Promise<Uint8Array>;
  newId(): string;
}
type Metadata = { v: 1; file: string; key: string; installation: string; baseUrl: string; owner: DraftOwner; pending: boolean };
const statuses = ['pending', 'sending', 'confirmed', 'conflict', 'failed'];
const failures = ['unavailable', 'invalid_response', 'rejected', 'locked', 'storage', 'limit', 'unauthorized'];

function commandOf(raw: unknown): DraftCommand | null {
  if (raw === null) return null;
  if (!object(raw) || !uuid(raw.commandId) || typeof raw.baseRevision !== 'number' || !Number.isSafeInteger(raw.baseRevision) || raw.baseRevision < 0 || raw.baseRevision > 1_000_000) throw new DraftFailure('storage');
  let resolution: DraftCommand['resolution'];
  if (raw.resolution !== undefined) {
    const r = raw.resolution;
    if (!object(r) || !uuid(r.conflictId) || (r.keep !== 'local' && r.keep !== 'server')) throw new DraftFailure('storage');
    resolution = { conflictId: r.conflictId, keep: r.keep };
  }
  return { commandId: raw.commandId, baseRevision: raw.baseRevision, content: contentOf(raw.content), ...(resolution ? { resolution } : {}) };
}

export function entriesOf(raw: unknown): DraftEntry[] {
  if (!Array.isArray(raw) || raw.length > 20) throw new DraftFailure('storage');
  const entries = raw.map(item => {
    if (!object(item) || !uuid(item.draftId) || typeof item.status !== 'string' || !statuses.includes(item.status)
      || typeof item.attempted !== 'boolean' || typeof item.savedAt !== 'number' || !Number.isSafeInteger(item.savedAt) || item.savedAt < 0
      || (item.failure !== undefined && (typeof item.failure !== 'string' || !failures.includes(item.failure)))) throw new DraftFailure('storage');
    const content = contentOf(item.content); const command = commandOf(item.command);
    const confirmed = item.confirmed === null ? null : versionOf(item.confirmed);
    const conflictReply = item.conflict === undefined ? undefined : replyOf({ status: 'conflict', conflict: item.conflict });
    const conflict = conflictReply?.status === 'conflict' ? conflictReply.conflict : undefined;
    if ((confirmed && (confirmed.draftId !== item.draftId || confirmed.content.policyId !== content.policyId))
      || (command && command.content.policyId !== content.policyId) || (conflict && conflict.draftId !== item.draftId)
      || (item.status === 'confirmed' && (!confirmed || command)) || (item.status !== 'confirmed' && !command)
      || (item.status === 'conflict' && !conflict)) throw new DraftFailure('storage');
    return { draftId: item.draftId, content, confirmed, command, status: item.status as DraftEntry['status'], attempted: item.attempted,
      savedAt: item.savedAt, ...(conflict ? { conflict } : {}), ...(item.failure ? { failure: item.failure as DraftEntry['failure'] } : {}) };
  });
  if (new Set(entries.map(e => e.draftId)).size !== entries.length) throw new DraftFailure('storage');
  return entries;
}

// Immutable encrypted files are committed by a small, read-back-verified keychain pointer. A failed write never replaces the last durable generation.
export class EncryptedDraftStorage implements DraftStorage {
  private unlocked = false;
  private epoch = 0;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly baseUrl: string, private readonly custody: DraftCustody) {}
  private serial<T>(work: () => Promise<T>): Promise<T> { const next = this.tail.then(work, work); this.tail = next.catch(() => undefined); return next; }
  private async available() { if (!await this.custody.available()) throw new DraftFailure('storage'); }
  private assertOpen(epoch: number) { if (!this.unlocked || this.epoch !== epoch) throw new DraftFailure('locked'); }

  async unlock(): Promise<void> {
    const epoch = this.epoch;
    await this.available(); await this.custody.authenticate();
    if (epoch !== this.epoch) throw new DraftFailure('locked');
    this.unlocked = true;
  }
  lock(): void { this.unlocked = false; this.epoch++; }

  private async metadata(): Promise<Metadata | null> {
    const text = await this.custody.readMeta();
    if (text === null) return null;
    const raw: unknown = JSON.parse(text);
    if (!object(raw) || raw.v !== 1 || !uuid(raw.file) || !uuid(raw.installation) || typeof raw.key !== 'string' || !/^[a-f0-9]{64}$/.test(raw.key)
      || typeof raw.baseUrl !== 'string' || typeof raw.pending !== 'boolean' || !object(raw.owner) || !uuid(raw.owner.clientId) || !uuid(raw.owner.subjectToken)) throw new DraftFailure('storage');
    return { v: 1, file: raw.file, key: raw.key, installation: raw.installation, baseUrl: raw.baseUrl, pending: raw.pending, owner: { clientId: raw.owner.clientId, subjectToken: raw.owner.subjectToken } };
  }
  private aad(meta: Pick<Metadata, 'baseUrl' | 'installation' | 'owner'>): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(['claim-drafts.v1', meta.baseUrl, meta.installation, meta.owner.clientId, meta.owner.subjectToken]));
  }

  async hasPending(): Promise<boolean> {
    if (!await this.custody.available() || await this.custody.readDiscard()) return false;
    const meta = await this.metadata();
    return meta !== null && meta.baseUrl === this.baseUrl && meta.pending;
  }

  read(owner?: DraftOwner): Promise<{ owner: DraftOwner; entries: DraftEntry[] } | null> {
    const epoch = this.epoch;
    return this.serial(async () => {
      this.assertOpen(epoch); await this.available();
      if (await this.custody.readDiscard()) throw new DraftFailure('storage');
      const meta = await this.metadata();
      if (!meta) return null;
      if (meta.baseUrl !== this.baseUrl || meta.installation !== await this.custody.installationId() || (owner && !sameOwner(meta.owner, owner))) throw new DraftFailure('unauthorized');
      const bytes = await this.custody.readBlob(meta.file);
      if (bytes.length > 262_172) throw new DraftFailure('storage');
      const plain = await this.custody.unseal(bytes, meta.key, this.aad(meta));
      const entries = entriesOf(JSON.parse(new TextDecoder().decode(plain)));
      this.assertOpen(epoch);
      return { owner: meta.owner, entries };
    });
  }

  write(owner: DraftOwner, sources: readonly DraftEntry[]): Promise<void> {
    const epoch = this.epoch;
    return this.serial(async () => {
      this.assertOpen(epoch); await this.available();
      if (!uuid(owner.clientId) || !uuid(owner.subjectToken) || await this.custody.readDiscard()) throw new DraftFailure('storage');
      const old = await this.metadata();
      if (old && (old.baseUrl !== this.baseUrl || !sameOwner(old.owner, owner))) throw new DraftFailure('unauthorized');
      const payload = new TextEncoder().encode(JSON.stringify(entriesOf(sources)));
      if (payload.length > 262_144) throw new DraftFailure('limit');
      const context = { v: 1 as const, baseUrl: this.baseUrl, installation: await this.custody.installationId(), owner, pending: sources.some(e => e.command !== null) };
      if (old && old.installation !== context.installation) throw new DraftFailure('unauthorized');
      const sealed = await this.custody.seal(payload, this.aad(context));
      const meta: Metadata = { ...context, file: this.custody.newId(), key: sealed.key };
      await this.custody.writeBlob(meta.file, sealed.bytes);
      const verified = await this.custody.unseal(await this.custody.readBlob(meta.file), meta.key, this.aad(meta));
      if (new TextDecoder().decode(verified) !== new TextDecoder().decode(payload)) throw new DraftFailure('storage');
      this.assertOpen(epoch);
      const pointer = JSON.stringify(meta);
      await this.custody.writeMeta(pointer);
      if (await this.custody.readMeta() !== pointer) throw new DraftFailure('storage');
      this.assertOpen(epoch);
      // Cleanup is optional after a verified commit; orphan ciphertext cannot replace the committed pointer.
      await this.custody.removeBlobs(meta.file).catch(() => undefined);
    });
  }

  clear(): Promise<void> {
    this.lock();
    return this.serial(async () => {
      let marked = false;
      try { await this.custody.writeDiscard(); marked = await this.custody.readDiscard(); } catch { /* Still attempt cryptographic erasure. */ }
      await this.custody.removeMeta();
      if (await this.custody.readMeta() !== null) throw new DraftFailure('storage');
      await this.custody.removeBlobs();
      if (marked) {
        await this.custody.removeDiscard();
        if (await this.custody.readDiscard()) throw new DraftFailure('storage');
      }
    });
  }
}
