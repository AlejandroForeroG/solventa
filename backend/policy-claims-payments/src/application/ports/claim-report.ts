import type { EvidenceContentType, ReportInput } from '../../domain/claim-report';

export type ReportOwner = { clientId: string; subjectToken: string };
export type DraftView = { claimId: string; state: string; evidence: { fileId: string; state: 'pending' | 'verified' }[] };
export type StoredEvidence = { claimState: string; contentType: EvidenceContentType; byteSize: number; sha256: string; state: 'pending' | 'uploaded' | 'verified' };

export type DraftOutcome = { status: 'created' | 'replayed'; claim: DraftView } | { status: 'policy_not_found' | 'outside_coverage' | 'idempotency_conflict' };
export type SubmitOutcome =
  | { status: 'submitted' | 'already_submitted'; claimId: string; claimNumber: string; submittedAt: string }
  | { status: 'incomplete'; missing: string[] }
  | { status: 'not_found' };

// Every operation resolves the claim through the owner's policy, so another customer's claim is indistinguishable from a missing one.
export interface ClaimReportStore {
  createDraft(input: { owner: ReportOwner; report: ReportInput; idempotencyKey: string; requestHash: string; traceId: string }): Promise<DraftOutcome>;
  evidence(owner: ReportOwner, claimId: string, fileId: string): Promise<StoredEvidence | null>;
  markVerified(owner: ReportOwner, claimId: string, fileId: string, traceId: string): Promise<boolean>;
  submit(owner: ReportOwner, claimId: string, traceId: string): Promise<SubmitOutcome>;
}

export type EvidencePut = 'stored' | 'checksum_mismatch' | 'size_mismatch';
// The core only needs to abandon a body it refuses; the adapter chooses the concrete stream type, so no platform type enters the core.
export interface EvidenceBody { cancel(): Promise<void> }
// SQL and the object store share no transaction: an object is written first and recorded after, and a repeated upload replaces it with identical bytes.
export interface ClaimEvidenceStore<Body extends EvidenceBody = EvidenceBody> {
  put(key: string, body: Body, meta: { contentType: string; byteSize: number; sha256: string }): Promise<EvidencePut>;
}
export interface ReportDigest { sha256Hex(content: string): Promise<string> }
