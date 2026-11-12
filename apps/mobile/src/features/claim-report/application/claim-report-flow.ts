import { admit, manifestOf, totalBytes, validate, type Draft, type EventType, type EvidenceCandidate, type EvidenceItem, type Issue, type Manifest, type Preview, type PolicyWindow, type RejectedCandidate } from '../domain/report';
import { AuthFailure } from '../../authentication/domain/session';
import { ClaimReportFailure, type ClaimFailureCode, type ClaimReportApi, type EvidenceFiles, type FileDigest } from './ports';

export type Phase =
  | { kind: 'editing' }
  | { kind: 'sending'; stage: 'preparing' | 'creating' | 'uploading' | 'submitting'; done: number; total: number }
  | { kind: 'failed'; failure: ClaimFailureCode; missing: number; cause?: string }
  | { kind: 'submitted'; claimNumber: string; submittedAt: string; files: number; bytes: number };
export type Snapshot = { draft: Draft; issues: readonly Issue[]; rejected: readonly RejectedCandidate[]; phase: Phase };

type Dependencies = { policyId: string; window: PolicyWindow; api: ClaimReportApi; digest: FileDigest; files: EvidenceFiles; newId: () => string; now: () => Date };
type Attempt = { key: string; digests: Map<string, string>; manifest?: Manifest; claimId?: string; verified: Set<string> };

// Holds one report in memory. A retry reuses the key, the declaration and the files already received, so repeating a send never makes a second case.
// The files the app created are released when their life ends: when they are rejected or removed, when the report is filed and when it is abandoned.
// A failed send keeps them, because the retry still needs them.
export class ClaimReportFlow {
  private snapshot: Snapshot;
  private attempt: Attempt | null = null;
  private sending = false;
  // Changes when the files of the report are released, so that work started before it never touches what came after.
  private epoch = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: Dependencies) {
    this.snapshot = { draft: { policyId: deps.policyId, eventType: null, occurredAt: deps.now(), place: '', description: '', evidence: [] }, issues: [], rejected: [], phase: { kind: 'editing' } };
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;

  setEventType(eventType: EventType) { this.edit({ eventType }); }
  setOccurredAt(occurredAt: Date) { this.edit({ occurredAt }); }
  setPlace(place: string) { this.edit({ place }); }
  setDescription(description: string) { this.edit({ description }); }
  remove(id: string) {
    const removed = this.snapshot.draft.evidence.find(item => item.id === id);
    if (!removed || this.locked()) return;
    this.edit({ evidence: this.snapshot.draft.evidence.filter(item => item.id !== id) });
    void this.release([removed]);
  }

  add(candidates: readonly EvidenceCandidate[]) {
    if (this.locked()) { void this.deps.files.dispose(candidates.filter(candidate => candidate.owned).map(candidate => candidate.uri)); return; }
    let evidence = this.snapshot.draft.evidence;
    const added: EvidenceItem[] = [];
    const rejected: RejectedCandidate[] = [];
    const dropped: string[] = [];
    for (const candidate of candidates) {
      const result = admit(evidence, candidate, this.deps.newId());
      if ('item' in result) { evidence = [...evidence, result.item]; added.push(result.item); } else { rejected.push(result.rejected); if (candidate.owned) dropped.push(candidate.uri); }
    }
    this.edit({ evidence }, rejected);
    if (dropped.length) void this.deps.files.dispose(dropped);
    for (const item of added) if (item.preview) void this.preview(item);
  }

  // The report is abandoned: the screen is gone, the session ended or another account signed in. Nothing of it is kept.
  async dispose(): Promise<void> {
    const evidence = this.snapshot.draft.evidence;
    this.epoch++;
    this.attempt = null;
    if (evidence.length) this.emit({ ...this.snapshot, draft: { ...this.snapshot.draft, evidence: [] }, issues: [], rejected: [] });
    await this.release(evidence);
  }

  dismissRejected() { this.emit({ ...this.snapshot, rejected: [] }); }

  // Returns true when the report may be reviewed; otherwise the issues stay visible next to their fields.
  review(): boolean {
    const issues = validate(this.snapshot.draft, this.deps.window, this.deps.now());
    this.emit({ ...this.snapshot, issues, phase: { kind: 'editing' } });
    return issues.length === 0;
  }

  backToEditing() { this.emit({ ...this.snapshot, phase: { kind: 'editing' } }); }

  async send(): Promise<void> {
    if (this.sending || this.snapshot.phase.kind === 'submitted') return;
    const issues = validate(this.snapshot.draft, this.deps.window, this.deps.now());
    if (issues.length) { this.emit({ ...this.snapshot, issues, phase: { kind: 'editing' } }); return; }
    this.sending = true;
    const epoch = this.epoch;
    const draft = this.snapshot.draft;
    const total = draft.evidence.length;
    const attempt: Attempt = this.attempt ??= { key: this.deps.newId(), digests: new Map<string, string>(), verified: new Set<string>() };
    try {
      this.progress('preparing', attempt.digests.size, total);
      for (const item of draft.evidence) {
        if (!attempt.digests.has(item.id)) attempt.digests.set(item.id, await this.deps.digest.sha256(item.uri));
        this.progress('preparing', attempt.digests.size, total);
      }
      if (epoch !== this.epoch) return;
      // The declaration is fixed on the first attempt: the same key must always carry the same body.
      attempt.manifest ??= manifestOf(draft as Draft & { eventType: EventType }, attempt.digests);
      if (!attempt.claimId) {
        this.progress('creating', 0, total);
        const receipt = await this.deps.api.createDraft(attempt.manifest, attempt.key);
        attempt.claimId = receipt.claimId;
        for (const file of receipt.evidence) if (file.state === 'verified') attempt.verified.add(file.fileId);
      }
      for (const item of draft.evidence) {
        if (attempt.verified.has(item.id)) continue;
        if (epoch !== this.epoch) return;
        this.progress('uploading', attempt.verified.size, total);
        await this.deps.api.upload(attempt.claimId, item);
        attempt.verified.add(item.id);
      }
      if (epoch !== this.epoch) return;
      this.progress('submitting', total, total);
      const receipt = await this.deps.api.submit(attempt.claimId);
      this.attempt = null;
      this.emit({ ...this.snapshot, issues: [], phase: { kind: 'submitted', claimNumber: receipt.claimNumber, submittedAt: receipt.submittedAt, files: total, bytes: totalBytes(draft.evidence) } });
      // The case exists, so the files are no longer needed on the device.
      this.epoch++;
      void this.release(this.snapshot.draft.evidence);
    } catch (error) {
      const failure = error instanceof ClaimReportFailure ? error
        : new ClaimReportFailure(error instanceof AuthFailure ? (error.kind === 'forbidden' ? 'forbidden' : 'unauthorized') : 'unavailable');
      // The server names the files it still lacks, so only those are sent again.
      for (const id of failure.detail.missing ?? []) attempt.verified.delete(id);
      // A file whose checksum no longer matches changed on the device: the declaration is stale and the next attempt starts a new one.
      if (failure.code === 'integrity' || failure.code === 'conflict') this.attempt = null;
      const origin = failure.cause ?? (error instanceof ClaimReportFailure || error instanceof AuthFailure ? undefined : error);
      const cause = origin === undefined ? undefined : origin instanceof Error ? `${origin.name}: ${origin.message}` : String(origin);
      this.emit({ ...this.snapshot, phase: { kind: 'failed', failure: failure.code, missing: failure.detail.missing?.length ?? 0, ...(cause ? { cause } : {}) } });
    } finally { this.sending = false; }
  }

  private locked() { return this.snapshot.phase.kind === 'sending' || this.snapshot.phase.kind === 'submitted'; }

  // The thumbnail is made after the file is admitted. If the file was removed or the report released meanwhile, the image is deleted instead of shown.
  private async preview(item: EvidenceItem) {
    const epoch = this.epoch;
    let uri: string | null = null;
    try { uri = await this.deps.files.thumbnail(item.uri); } catch { uri = null; }
    const present = epoch === this.epoch && this.snapshot.draft.evidence.some(current => current.id === item.id);
    if (!present) { if (uri) await this.deps.files.dispose([uri]); return; }
    const preview: Preview = uri ? { status: 'ready', uri } : { status: 'failed' };
    // A thumbnail is not part of the declaration, so it changes neither the attempt nor the phase.
    this.emit({ ...this.snapshot, draft: { ...this.snapshot.draft, evidence: this.snapshot.draft.evidence.map(current => current.id === item.id ? { ...current, preview } : current) } });
  }

  private release(items: readonly EvidenceItem[]): Promise<void> {
    const uris = items.flatMap(item => [...(item.owned ? [item.uri] : []), ...(item.preview?.status === 'ready' ? [item.preview.uri] : [])]);
    return uris.length ? this.deps.files.dispose(uris) : Promise.resolve();
  }

  private edit(change: Partial<Draft>, rejected: readonly RejectedCandidate[] = []) {
    if (this.locked()) return;
    // Any change makes the declaration different, so a new key is needed; an abandoned draft is never submitted.
    this.attempt = null;
    this.emit({ draft: { ...this.snapshot.draft, ...change }, issues: [], rejected, phase: { kind: 'editing' } });
  }

  private progress(stage: 'preparing' | 'creating' | 'uploading' | 'submitting', done: number, total: number) {
    this.emit({ ...this.snapshot, phase: { kind: 'sending', stage, done, total } });
  }

  private emit(snapshot: Snapshot) {
    this.snapshot = snapshot;
    for (const listener of [...this.listeners]) listener();
  }
}
