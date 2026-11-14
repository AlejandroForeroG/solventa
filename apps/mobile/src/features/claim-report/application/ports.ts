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

// The device position, read only after the customer asks for it. The reading stops when the signal aborts and never rejects.
export type LocationReading = { status: 'ok'; latitude: number; longitude: number } | { status: 'denied' } | { status: 'failed' };
export interface LocationSource { read(signal: AbortSignal): Promise<LocationReading> }

export interface EvidenceFiles {
  // A still image from a video, or null when it cannot be made. It never rejects.
  thumbnail(uri: string): Promise<string | null>;
  // Deletes copies the app created. It never rejects and never touches a file that is not an app copy.
  dispose(uris: readonly string[]): Promise<void>;
}

export type CaptureOutcome =
  | { status: 'ok'; candidates: EvidenceCandidate[] }
  | { status: 'cancelled' }
  | { status: 'permission'; permission: 'camera' | 'library'; canAskAgain: boolean }
  | { status: 'failed' };

export interface EvidenceSource {
  takePhoto(): Promise<CaptureOutcome>;
  recordVideo(): Promise<CaptureOutcome>;
  choose(limit: number): Promise<CaptureOutcome>;
  scanDocument(): Promise<CaptureOutcome>;
  chooseDocument(): Promise<CaptureOutcome>;
}
