import { admit, manifestOf, totalBytes, validate, type Draft, type EventType, type EvidenceCandidate, type Issue, type Manifest, type PolicyWindow, type RejectedCandidate } from '../domain/report';
import { AuthFailure } from '../../authentication/domain/session';
import { ClaimReportFailure, type ClaimFailureCode, type ClaimReportApi, type FileDigest } from './ports';

export type Phase =
  | { kind: 'editing' }
  | { kind: 'sending'; stage: 'preparing' | 'creating' | 'uploading' | 'submitting'; done: number; total: number }
  | { kind: 'failed'; failure: ClaimFailureCode; missing: number; cause?: string }
  | { kind: 'submitted'; claimNumber: string; submittedAt: string; files: number; bytes: number };
export type Snapshot = { draft: Draft; issues: readonly Issue[]; rejected: readonly RejectedCandidate[]; phase: Phase };

type Dependencies = { policyId: string; window: PolicyWindow; api: ClaimReportApi; digest: FileDigest; newId: () => string; now: () => Date };
type Attempt = { key: string; digests: Map<string, string>; manifest?: Manifest; claimId?: string; verified: Set<string> };

// Holds one report in memory. A retry reuses the key, the declaration and the files already received, so repeating a send never makes a second case.
export class ClaimReportFlow {
  private snapshot: Snapshot;
  private attempt: Attempt | null = null;
  private sending = false;
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
  remove(id: string) { this.edit({ evidence: this.snapshot.draft.evidence.filter(item => item.id !== id) }); }

  add(candidates: readonly EvidenceCandidate[]) {
    let evidence = this.snapshot.draft.evidence;
    const rejected: RejectedCandidate[] = [];
    for (const candidate of candidates) {
      const result = admit(evidence, candidate, this.deps.newId());
      if ('item' in result) evidence = [...evidence, result.item]; else rejected.push(result.rejected);
    }
    this.edit({ evidence }, rejected);
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
    const draft = this.snapshot.draft;
    const total = draft.evidence.length;
    const attempt: Attempt = this.attempt ??= { key: this.deps.newId(), digests: new Map<string, string>(), verified: new Set<string>() };
    try {
      this.progress('preparing', attempt.digests.size, total);
      for (const item of draft.evidence) {
        if (!attempt.digests.has(item.id)) attempt.digests.set(item.id, await this.deps.digest.sha256(item.uri));
        this.progress('preparing', attempt.digests.size, total);
      }
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
        this.progress('uploading', attempt.verified.size, total);
        await this.deps.api.upload(attempt.claimId, item);
        attempt.verified.add(item.id);
      }
      this.progress('submitting', total, total);
      const receipt = await this.deps.api.submit(attempt.claimId);
      this.attempt = null;
      this.emit({ ...this.snapshot, issues: [], phase: { kind: 'submitted', claimNumber: receipt.claimNumber, submittedAt: receipt.submittedAt, files: total, bytes: totalBytes(draft.evidence) } });
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

  private edit(change: Partial<Draft>, rejected: readonly RejectedCandidate[] = []) {
    if (this.snapshot.phase.kind === 'sending' || this.snapshot.phase.kind === 'submitted') return;
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
