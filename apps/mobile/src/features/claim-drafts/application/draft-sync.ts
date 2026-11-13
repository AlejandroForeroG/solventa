import { AuthFailure } from '../../authentication/domain/session';
import { contentOf, DraftFailure, sameOwner, type DraftContent, type DraftEntry, type DraftFailureKind, type DraftOwner, type DraftSnapshot } from '../domain/draft';
import type { DraftApi, DraftStorage } from './ports';

type Dependencies = { storage: DraftStorage; api: DraftApi; newId(): string; now(): number };
const failureOf = (error: unknown): DraftFailureKind => error instanceof AuthFailure ? (error.kind === 'unavailable' ? 'unavailable' : 'unauthorized')
  : error instanceof DraftFailure ? error.kind : 'storage';

export class DraftSync {
  private snapshot: DraftSnapshot = { status: 'locked' };
  private generation = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private syncing = false;
  private opening: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly deps: Dependencies) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private emit(snapshot: DraftSnapshot) { this.snapshot = snapshot; this.listeners.forEach(l => l()); }
  private serial<T>(work: () => Promise<T>): Promise<T> { const next = this.tail.then(work, work); this.tail = next.catch(() => undefined); return next; }

  open(owner?: DraftOwner): Promise<void> {
    if (this.opening) return this.opening;
    const opening = this.openWorkspace(owner);
    this.opening = opening;
    return opening.finally(() => { if (this.opening === opening) this.opening = null; });
  }

  private async openWorkspace(owner?: DraftOwner): Promise<void> {
    const epoch = ++this.generation;
    this.emit({ status: 'loading' });
    try {
      await this.deps.storage.unlock();
      const saved = await this.deps.storage.read(owner);
      if (epoch !== this.generation) return;
      const bound = owner ?? saved?.owner;
      if (!bound) { this.emit({ status: 'failed', failure: 'unavailable' }); return; }
      this.emit({ status: 'ready', owner: bound, entries: (saved?.entries ?? []).map(e => e.status === 'sending' ? { ...e, status: 'pending' } : e) });
    } catch (error) { if (epoch === this.generation) this.emit({ status: 'failed', failure: failureOf(error) }); }
  }

  lock(): void { this.generation++; this.deps.storage.lock(); this.emit({ status: 'locked' }); }

  save(draftId: string, source: DraftContent): Promise<void> {
    return this.serial(async () => {
      if (this.snapshot.status !== 'ready') throw new DraftFailure('locked');
      const { owner, entries } = this.snapshot;
      const existing = entries.find(e => e.draftId === draftId);
      // Once a request may have reached the server its immutable key/body must be retried before further editing.
      const refused = existing?.status === 'failed' && existing.failure === 'rejected';
      if (existing && (existing.status === 'sending' || existing.status === 'conflict' || (existing.command && existing.attempted && !refused))) throw new DraftFailure('rejected');
      if (!existing && entries.length >= 20) throw new DraftFailure('limit');
      const content = contentOf(source);
      if (existing && existing.content.policyId !== content.policyId) throw new DraftFailure('rejected');
      const entry: DraftEntry = { draftId, content, confirmed: existing?.confirmed ?? null,
        command: { commandId: this.deps.newId(), baseRevision: existing?.confirmed?.revision ?? 0, content },
        status: 'pending', attempted: false, savedAt: this.deps.now() };
      await this.persist(owner, [...entries.filter(e => e.draftId !== draftId), entry]);
    });
  }

  resolve(draftId: string, keep: 'local' | 'server'): Promise<void> {
    return this.serial(async () => {
      if (this.snapshot.status !== 'ready') throw new DraftFailure('locked');
      const { owner, entries } = this.snapshot;
      const found = entries.find(e => e.draftId === draftId);
      if (!found?.conflict || found.status !== 'conflict') throw new DraftFailure('rejected');
      const c = found.conflict;
      const entry: DraftEntry = { ...found, status: 'pending', failure: undefined, attempted: false,
        command: { commandId: this.deps.newId(), baseRevision: c.server.revision, content: c.local, resolution: { conflictId: c.conflictId, keep } } };
      // The choice is committed before the network sees it; a crash or a lost response retries this exact command.
      await this.persist(owner, entries.map(e => e.draftId === draftId ? entry : e));
    });
  }

  retry(draftId: string): Promise<void> {
    return this.serial(async () => {
      if (this.snapshot.status !== 'ready') throw new DraftFailure('locked');
      const { owner, entries } = this.snapshot;
      const entry = entries.find(e => e.draftId === draftId);
      if (!entry?.command || entry.status === 'conflict') throw new DraftFailure('rejected');
      await this.persist(owner, entries.map(e => e.draftId === draftId ? { ...e, status: 'pending', failure: undefined } : e));
    });
  }

  async refresh(owner: DraftOwner): Promise<void> {
    const epoch = this.generation;
    try {
      const remote = await this.deps.api.list();
      await this.serial(async () => {
        if (epoch !== this.generation || this.snapshot.status !== 'ready' || !sameOwner(owner, this.snapshot.owner)) return;
        const entries = [...this.snapshot.entries];
        for (const draft of remote) {
          const old = entries.find(e => e.draftId === draft.draftId);
          if (old?.command || old?.status === 'conflict') continue;
          const next: DraftEntry = { draftId: draft.draftId, content: draft.content, confirmed: draft, command: null, status: 'confirmed', attempted: false, savedAt: this.deps.now() };
          if (old) entries[entries.indexOf(old)] = next; else if (entries.length < 20) entries.push(next);
        }
        await this.persist(owner, entries);
      });
    } catch (error) { this.reportFailure(epoch, failureOf(error)); }
  }

  async sync(owner: DraftOwner): Promise<void> {
    if (this.syncing || this.snapshot.status !== 'ready' || !sameOwner(owner, this.snapshot.owner)) return;
    this.syncing = true;
    const epoch = this.generation;
    try {
      const ids = this.snapshot.entries.filter(e => e.command && (e.status === 'pending' || e.status === 'sending' || (e.status === 'failed' && e.failure === 'unavailable'))).map(e => e.draftId);
      for (const id of ids) {
        if (epoch !== this.generation) break;
        const sending = await this.serial(async () => {
          if (this.snapshot.status !== 'ready' || epoch !== this.generation) return null;
          const entry = this.snapshot.entries.find(e => e.draftId === id);
          if (!entry?.command) return null;
          const next: DraftEntry = { ...entry, status: 'sending', attempted: true, failure: undefined };
          await this.persist(owner, this.snapshot.entries.map(e => e.draftId === id ? next : e));
          return next;
        });
        if (!sending?.command || epoch !== this.generation) continue;
        try {
          const result = await this.deps.api.sync(id, sending.command);
          await this.serial(async () => {
            if (epoch !== this.generation || this.snapshot.status !== 'ready') return;
            const entry: DraftEntry = result.status === 'confirmed'
              ? { ...sending, content: result.draft.content, confirmed: result.draft, command: null, status: 'confirmed', conflict: undefined, failure: undefined }
              : { ...sending, status: 'conflict', conflict: result.conflict, failure: undefined };
            await this.persist(owner, this.snapshot.entries.map(e => e.draftId === id ? entry : e));
          });
        } catch (error) {
          const kind = failureOf(error);
          await this.serial(async () => {
            if (epoch !== this.generation || this.snapshot.status !== 'ready') return;
            await this.persist(owner, this.snapshot.entries.map(e => e.draftId === id ? { ...sending, status: 'failed', failure: kind } : e));
          });
          if (kind === 'unauthorized' || kind === 'unavailable') break;
        }
      }
    } catch (error) { this.reportFailure(epoch, failureOf(error)); }
    finally { this.syncing = false; }
  }

  private async persist(owner: DraftOwner, entries: DraftEntry[]): Promise<void> {
    const epoch = this.generation;
    await this.deps.storage.write(owner, entries);
    if (epoch !== this.generation) throw new DraftFailure('locked');
    this.emit({ status: 'ready', owner, entries });
  }
  private reportFailure(epoch: number, failure: DraftFailureKind) {
    if (epoch === this.generation && this.snapshot.status === 'ready') this.emit({ ...this.snapshot, failure });
  }
}
