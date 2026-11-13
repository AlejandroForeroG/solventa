import { Client } from 'pg';
import { claimNumber, EVIDENCE_RETENTION_DAYS, REQUIRED_EVIDENCE, type EvidenceContentType } from '../../domain/claim-report';
import type { ClaimReportStore, DraftOutcome, DraftView, ReportOwner, StoredEvidence, SubmitOutcome } from '../../application/ports/claim-report';

const RETRYABLE = new Set(['40001', '23505']);
const AUDIT_RETENTION = "INTERVAL '90 days'";
type Db = Client;

export class SqlClaimReport implements ClaimReportStore {
  constructor(private readonly connectionString: string) {}

  // A serialization conflict or a concurrent identical request is retried as a whole, so the second attempt sees the first one's committed row.
  private async run<T>(work: (db: Db) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1500, query_timeout: 1500 });
      db.on('error', () => {});
      try {
        await db.connect();
        await db.query('BEGIN');
        const result = await work(db);
        await db.query('COMMIT');
        return result;
      } catch (error) {
        await db.query('ROLLBACK').catch(() => {});
        if (attempt < 3 && RETRYABLE.has((error as { code?: string }).code ?? '')) continue;
        throw error;
      } finally { await db.end().catch(() => {}); }
    }
  }

  async createDraft({ owner, report, idempotencyKey, requestHash, traceId }: Parameters<ClaimReportStore['createDraft']>[0]): Promise<DraftOutcome> {
    return this.run<DraftOutcome>(async db => {
      // Share the lifecycle policy lock so a concurrent termination and draft observe a serial order.
      const policy = (await db.query<{ effective_from: Date; effective_until: Date; lifecycle_at: Date | null }>(
        `SELECT p.effective_from,p.effective_until,lc.occurred_at AS lifecycle_at FROM policy.policies p
         LEFT JOIN policy.policy_lifecycle_changes lc ON lc.policy_id=p.id
         WHERE p.id=$1 AND p.subject_token=$2 AND p.status='issued' FOR UPDATE OF p`, [report.policyId, owner.subjectToken])).rows[0];
      if (!policy) return { status: 'policy_not_found' };
      const existing = (await db.query<{ id: string; request_hash: string }>(
        'SELECT id, request_hash FROM policy.claims WHERE policy_id = $1 AND idempotency_key = $2', [report.policyId, idempotencyKey])).rows[0];
      if (existing) return existing.request_hash === requestHash ? { status: 'replayed', claim: await this.view(db, existing.id) } : { status: 'idempotency_conflict' };
      const occurred = Date.parse(report.occurredAt);
      if (occurred < policy.effective_from.getTime() || occurred > policy.effective_until.getTime()
        || policy.lifecycle_at && occurred >= policy.lifecycle_at.getTime()) return { status: 'outside_coverage' };
      const claimId = (await db.query<{ id: string }>(`INSERT INTO policy.claims (policy_id, idempotency_key, request_hash, status, occurred_at, correlation_id, event_type, event_place, description,
          location_latitude, location_longitude, location_authorized_at)
        VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, $8, $9, $10, CASE WHEN $9::DECIMAL IS NULL THEN NULL ELSE now() END) RETURNING id`,
      [report.policyId, idempotencyKey, requestHash, report.occurredAt, traceId, report.eventType, report.place, report.description,
        report.location?.latitude ?? null, report.location?.longitude ?? null])).rows[0].id;
      for (const item of report.evidence) {
        await db.query(`INSERT INTO policy.evidence_metadata (claim_id, object_key, content_type, byte_size, checksum_sha256, state, retention_until, correlation_id, client_file_id)
          VALUES ($1, $2, $3, $4, $5, 'pending', now() + INTERVAL '${EVIDENCE_RETENTION_DAYS} days', $6, $7)`,
        [claimId, `claims/${claimId}/${item.fileId}`, item.contentType, item.byteSize, item.sha256, traceId, item.fileId]);
      }
      await this.audit(db, owner, 'claims.report.draft', claimId, traceId);
      return { status: 'created', claim: await this.view(db, claimId) };
    });
  }

  async evidence(owner: ReportOwner, claimId: string, fileId: string): Promise<StoredEvidence | null> {
    return this.run(async db => {
      const row = (await db.query<{ claim_state: string; content_type: EvidenceContentType; byte_size: string; checksum_sha256: string; state: StoredEvidence['state'] }>(
        `SELECT c.status AS claim_state, e.content_type, e.byte_size::STRING AS byte_size, e.checksum_sha256, e.state
         FROM policy.claims c JOIN policy.policies p ON p.id = c.policy_id JOIN policy.evidence_metadata e ON e.claim_id = c.id
         WHERE c.id = $1 AND e.client_file_id = $2 AND p.subject_token = $3`, [claimId, fileId, owner.subjectToken])).rows[0];
      return row ? { claimState: row.claim_state, contentType: row.content_type, byteSize: Number(row.byte_size), sha256: row.checksum_sha256, state: row.state } : null;
    });
  }

  async markVerified(owner: ReportOwner, claimId: string, fileId: string, traceId: string): Promise<boolean> {
    return this.run(async db => {
      const updated = await db.query(`UPDATE policy.evidence_metadata e SET state = 'verified', verified_at = now()
        FROM policy.claims c JOIN policy.policies p ON p.id = c.policy_id
        WHERE e.claim_id = c.id AND c.id = $1 AND e.client_file_id = $2 AND p.subject_token = $3 AND e.state <> 'verified'`, [claimId, fileId, owner.subjectToken]);
      if (updated.rowCount === 1) { await this.audit(db, owner, 'claims.report.evidence', claimId, traceId); return true; }
      // A concurrent identical upload may have recorded it first; that is still a received file.
      const verified = await db.query(`SELECT 1 FROM policy.evidence_metadata e JOIN policy.claims c ON c.id = e.claim_id JOIN policy.policies p ON p.id = c.policy_id
        WHERE c.id = $1 AND e.client_file_id = $2 AND p.subject_token = $3 AND e.state = 'verified'`, [claimId, fileId, owner.subjectToken]);
      return verified.rowCount === 1;
    });
  }

  async submit(owner: ReportOwner, claimId: string, traceId: string): Promise<SubmitOutcome> {
    return this.run<SubmitOutcome>(async db => {
      const claim = (await db.query<{ status: string; claim_number: string | null; submitted_at: Date | null }>(
        `SELECT c.status, c.claim_number, c.submitted_at FROM policy.claims c JOIN policy.policies p ON p.id = c.policy_id
         WHERE c.id = $1 AND p.subject_token = $2 FOR UPDATE OF c`, [claimId, owner.subjectToken])).rows[0];
      if (!claim) return { status: 'not_found' };
      if (claim.status !== 'draft') {
        // Only a claim this flow numbered can be acknowledged again; a claim from another flow is not a report.
        return claim.claim_number && claim.submitted_at
          ? { status: 'already_submitted', claimId, claimNumber: claim.claim_number, submittedAt: claim.submitted_at.toISOString() } : { status: 'not_found' };
      }
      const missing = (await db.query<{ client_file_id: string }>(
        `SELECT client_file_id FROM policy.evidence_metadata WHERE claim_id = $1 AND state <> 'verified' ORDER BY client_file_id`, [claimId])).rows.map(row => row.client_file_id);
      const received = (await db.query<{ n: number }>(`SELECT count(*)::INT4 AS n FROM policy.evidence_metadata WHERE claim_id = $1 AND state = 'verified'`, [claimId])).rows[0].n;
      if (missing.length > 0 || received < REQUIRED_EVIDENCE) return { status: 'incomplete', missing };
      const year = (await db.query<{ year: number }>(`SELECT EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/Bogota'))::INT4 AS year`)).rows[0].year;
      const sequence = (await db.query<{ last_number: number }>(`INSERT INTO policy.claim_number_counters (year, last_number) VALUES ($1, 1)
        ON CONFLICT (year) DO UPDATE SET last_number = policy.claim_number_counters.last_number + 1, updated_at = now() RETURNING last_number`, [year])).rows[0].last_number;
      const number = claimNumber(year, sequence);
      const submitted = (await db.query<{ submitted_at: Date }>(`UPDATE policy.claims SET status = 'unassigned', claim_number = $2, submitted_at = now(), evidence_required = $3,
        version = version + 1, updated_at = now() WHERE id = $1 RETURNING submitted_at`, [claimId, number, REQUIRED_EVIDENCE])).rows[0];
      await this.audit(db, owner, 'claims.report.submit', claimId, traceId);
      return { status: 'submitted', claimId, claimNumber: number, submittedAt: submitted.submitted_at.toISOString() };
    });
  }

  private async view(db: Db, claimId: string): Promise<DraftView> {
    const claim = (await db.query<{ status: string }>('SELECT status FROM policy.claims WHERE id = $1', [claimId])).rows[0];
    const files = await db.query<{ client_file_id: string; state: string }>('SELECT client_file_id, state FROM policy.evidence_metadata WHERE claim_id = $1 ORDER BY client_file_id', [claimId]);
    return { claimId, state: claim.status, evidence: files.rows.map(row => ({ fileId: row.client_file_id, state: row.state === 'verified' ? 'verified' : 'pending' })) };
  }

  private audit(db: Db, owner: ReportOwner, action: string, claimId: string, traceId: string) {
    return db.query(`INSERT INTO policy.audit_events (actor_reference, action, resource_type, resource_id, outcome, correlation_id, retention_until)
      VALUES ($1, $2, 'claim', $3, 'success', $4, now() + ${AUDIT_RETENTION})`, [owner.clientId, action, claimId, traceId]);
  }
}
