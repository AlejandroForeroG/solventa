import type { EvidenceCandidate, EvidenceItem, Manifest } from '../domain/report';

export type ClaimFailureCode =
  | 'unauthorized' | 'forbidden' | 'invalid' | 'not_found' | 'outside_coverage' | 'conflict' | 'integrity' | 'media'
  | 'incomplete' | 'unavailable' | 'invalid_response';

export class ClaimReportFailure extends Error {
  // The cause is for developers: it names the transport or device error behind a generic outage and never reaches a customer.
  constructor(public readonly code: ClaimFailureCode, public readonly detail: { fields?: string[]; missing?: string[] } = {}, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'ClaimReportFailure';
  }
}

export type DraftReceipt = { claimId: string; evidence: { fileId: string; state: 'pending' | 'verified' }[] };
export type SubmitReceipt = { claimId: string; claimNumber: string; submittedAt: string };

export interface ClaimReportApi {
  // The key is retained across retries so a repeated request returns the same draft instead of creating a second claim.
  createDraft(manifest: Manifest, idempotencyKey: string): Promise<DraftReceipt>;
  upload(claimId: string, file: EvidenceItem): Promise<void>;
  submit(claimId: string): Promise<SubmitReceipt>;
}

export interface FileDigest { sha256(uri: string): Promise<string> }

export type CaptureOutcome =
  | { status: 'ok'; candidates: EvidenceCandidate[] }
  | { status: 'cancelled' }
  | { status: 'permission'; permission: 'camera' | 'library'; canAskAgain: boolean }
  | { status: 'failed' };

export interface EvidenceSource {
  takePhoto(): Promise<CaptureOutcome>;
  recordVideo(): Promise<CaptureOutcome>;
  choose(limit: number): Promise<CaptureOutcome>;
}
