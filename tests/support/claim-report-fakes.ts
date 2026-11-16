import { createHash } from 'node:crypto';
import { claimNumber } from '../../backend/policy-claims-payments/src/domain/claim-report';
import type { ClaimEvidenceStore, ClaimReportStore, DraftView, ReportOwner, StoredEvidence } from '../../backend/policy-claims-payments/src/application/ports/claim-report';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// A faithful in-memory copy of the store's contract: the claim is always resolved through the owner's policy.
export type Policy = { subject: string; issued: boolean; from: number; until: number };
export function memoryStore(policies: Map<string, Policy>, now: Date) {
  type Row = { id: string; owner: string; policyId: string; key: string; hash: string; state: string; number: string | null; submittedAt: string | null; files: Map<string, StoredEvidence> };
  const claims = new Map<string, Row>(); let sequence = 0;
  const owned = (owner: ReportOwner, id: string) => { const row = claims.get(id); return row && policies.get(row.policyId)?.subject === owner.subjectToken ? row : undefined; };
  const view = (row: Row): DraftView => ({ claimId: row.id, state: row.state, evidence: [...row.files].map(([fileId, file]) => ({ fileId, state: file.state === 'verified' ? 'verified' as const : 'pending' as const })) });
  const store: ClaimReportStore = {
    async createDraft({ owner, report: input, idempotencyKey, requestHash }) {
      const policy = policies.get(input.policyId);
      if (!policy || policy.subject !== owner.subjectToken || !policy.issued) return { status: 'policy_not_found' };
      const existing = [...claims.values()].find(row => row.policyId === input.policyId && row.key === idempotencyKey);
      if (existing) return existing.hash === requestHash ? { status: 'replayed', claim: view(existing) } : { status: 'idempotency_conflict' };
      const occurred = Date.parse(input.occurredAt);
      if (occurred < policy.from || occurred > policy.until) return { status: 'outside_coverage' };
      const row: Row = { id: `91000000-0000-4000-8000-${String(claims.size + 1).padStart(12, '0')}`, owner: owner.clientId, policyId: input.policyId, key: idempotencyKey, hash: requestHash,
        state: 'draft', number: null, submittedAt: null, files: new Map(input.evidence.map(item => [item.fileId, { claimState: 'draft', contentType: item.contentType, byteSize: item.byteSize, sha256: item.sha256, state: 'pending' as const }])) };
      claims.set(row.id, row);
      return { status: 'created', claim: view(row) };
    },
    async evidence(owner, claimId, fileId) { const row = owned(owner, claimId); const file = row?.files.get(fileId); return row && file ? { ...file, claimState: row.state } : null; },
    async markVerified(owner, claimId, fileId) { const file = owned(owner, claimId)?.files.get(fileId); if (!file) return false; file.state = 'verified'; return true; },
    async submit(owner, claimId) {
      const row = owned(owner, claimId); if (!row) return { status: 'not_found' };
      if (row.state !== 'draft') return row.number && row.submittedAt ? { status: 'already_submitted', claimId, claimNumber: row.number, submittedAt: row.submittedAt } : { status: 'not_found' };
      const missing = [...row.files].filter(([, file]) => file.state !== 'verified').map(([fileId]) => fileId).sort();
      if (missing.length) return { status: 'incomplete', missing };
      row.state = 'unassigned'; row.number = claimNumber(2026, ++sequence); row.submittedAt = now.toISOString();
      return { status: 'submitted', claimId, claimNumber: row.number, submittedAt: row.submittedAt };
    },
  };
  return { store, claims };
}

// The object store verifies the declared checksum while it receives the stream, as R2 does.
export type Stream = ReadableStream<Uint8Array>;
export function memoryEvidence() {
  const objects = new Map<string, Uint8Array>();
  const evidence: ClaimEvidenceStore<Stream> = {
    async put(key, body, meta) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      if (sha(bytes) !== meta.sha256) return 'checksum_mismatch';
      objects.set(key, bytes);
      return bytes.length === meta.byteSize ? 'stored' : 'size_mismatch';
    },
  };
  return { evidence, objects };
}
