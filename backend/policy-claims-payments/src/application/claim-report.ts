import { canonicalReport, evidenceObjectKey, parseReport } from '../domain/claim-report';
import type { ClaimEvidenceStore, ClaimReportStore, DraftView, EvidenceBody, ReportDigest, ReportOwner, SubmitOutcome } from './ports/claim-report';

export type CreateResult = { status: 'created' | 'replayed'; claim: DraftView } | { status: 'invalid'; fields: string[] }
  | { status: 'policy_not_found' | 'outside_coverage' | 'idempotency_conflict' };
export type ReceiveResult = { status: 'stored' | 'already_received' | 'not_found' | 'claim_not_draft' | 'content_type_mismatch' | 'size_mismatch' | 'checksum_mismatch' | 'evidence_unavailable' };
export type Upload<Body extends EvidenceBody = EvidenceBody> = { contentType: string | null; length: number | null; body: Body | null };

export class ClaimReport<Body extends EvidenceBody = EvidenceBody> {
  // The evidence store is absent in an environment whose bucket is not provisioned; uploads then fail closed and nothing is acknowledged.
  constructor(private readonly store: ClaimReportStore, private readonly evidence: ClaimEvidenceStore<Body> | undefined, private readonly digest: ReportDigest, private readonly clock: { now(): Date }) {}

  async create(owner: ReportOwner, body: unknown, idempotencyKey: string, traceId: string): Promise<CreateResult> {
    const parsed = parseReport(body, this.clock.now());
    if (!parsed.ok) return { status: 'invalid', fields: parsed.fields };
    return this.store.createDraft({ owner, report: parsed.value, idempotencyKey, requestHash: await this.digest.sha256Hex(canonicalReport(parsed.value)), traceId });
  }

  async receive(owner: ReportOwner, claimId: string, fileId: string, upload: Upload<Body>, traceId: string): Promise<ReceiveResult> {
    const stored = await this.store.evidence(owner, claimId, fileId);
    if (!stored) { await upload.body?.cancel().catch(() => {}); return { status: 'not_found' }; }
    // A file already recorded as verified is acknowledged again, so a client that lost the answer can safely repeat the upload.
    if (stored.state === 'verified') { await upload.body?.cancel().catch(() => {}); return { status: 'already_received' }; }
    const refuse = async (status: ReceiveResult['status']) => { await upload.body?.cancel().catch(() => {}); return { status }; };
    if (stored.claimState !== 'draft') return refuse('claim_not_draft');
    if (!this.evidence) return refuse('evidence_unavailable');
    if ((upload.contentType ?? '').split(';')[0].trim().toLowerCase() !== stored.contentType) return refuse('content_type_mismatch');
    if (upload.length !== stored.byteSize || !upload.body) return refuse('size_mismatch');
    const put = await this.evidence.put(evidenceObjectKey(claimId, fileId), upload.body, { contentType: stored.contentType, byteSize: stored.byteSize, sha256: stored.sha256 });
    if (put !== 'stored') return { status: put };
    return (await this.store.markVerified(owner, claimId, fileId, traceId)) ? { status: 'stored' } : { status: 'not_found' };
  }

  submit(owner: ReportOwner, claimId: string, traceId: string): Promise<SubmitOutcome> {
    return this.store.submit(owner, claimId, traceId);
  }
}
