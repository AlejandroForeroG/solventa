import { Client } from 'pg';
import { decisionState, type ClaimDecisionInput } from '../../domain/claim-decision';
import { addClaimNotices } from './sql-claim-notices';
import type { ClaimState } from '../../domain/claims';
import type { ClaimDecisionActor, ClaimDecisionResult, ClaimDecisionStore } from '../../application/claim-decisions';

type ClaimRow = { status: ClaimState; assignee_id: string | null; evidence_required: number; subject_token: string };
type ExistingRow = { id: string; request_hash: string; resulting_state: 'approved' | 'rejected' };
type EvidenceRow = { id: string; state: string; checksum_sha256: string; verified_at: Date | null };

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class SqlClaimDecisions implements ClaimDecisionStore {
  constructor(private readonly connectionString: string) {}
  async decide(claimId: string, input: ClaimDecisionInput, actor: ClaimDecisionActor, idempotencyKey: string): Promise<ClaimDecisionResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await this.execute(claimId, input, actor, idempotencyKey); }
      catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if (attempt === 0 && (code === '40001' || code === '23505')) continue;
        throw error;
      }
    }
    throw new Error('claims_decision_retry_exhausted');
  }
  private async execute(claimId: string, input: ClaimDecisionInput, actor: ClaimDecisionActor, idempotencyKey: string): Promise<ClaimDecisionResult> {
    const keyHash = await digest(JSON.stringify([actor.clientId, idempotencyKey]));
    const requestHash = await digest(JSON.stringify(input));
    const client = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1500, query_timeout: 1500 });
    client.on('error', () => {});
    try {
      await client.connect();
      await client.query('BEGIN');
      await this.checkLease(client, actor.expiresAt);
      const claim = await client.query<ClaimRow>(`SELECT c.status,c.assignee_id,c.evidence_required::INT4 AS evidence_required,p.subject_token
        FROM policy.claims c JOIN policy.policies p ON p.id=c.policy_id WHERE c.id=$1 FOR UPDATE OF c`, [claimId]);
      const row = claim.rows[0];
      if (!row || row.assignee_id !== actor.clientId || row.subject_token === actor.subjectToken) {
        await client.query(`INSERT INTO policy.audit_events (actor_reference, action, resource_type, resource_id, outcome, correlation_id, retention_until)
          VALUES ($1, 'claims.decision.denied', 'claim', $2, 'not_found', $3, now() + INTERVAL '90 days')`, [actor.clientId, claimId, actor.traceId]);
        await this.checkLease(client, actor.expiresAt);
        await client.query('COMMIT');
        return { status: 'not_found' };
      }
      const existing = await client.query<ExistingRow>(`SELECT id, request_hash, resulting_state FROM policy.claim_decisions
        WHERE claim_id = $1 AND actor_id = $2 AND idempotency_key_hash = $3`, [claimId, actor.clientId, keyHash]);
      if (existing.rows[0]) {
        await this.checkLease(client, actor.expiresAt);
        await client.query('COMMIT');
        return existing.rows[0].request_hash === requestHash
          ? { status: 'ok', decisionId: existing.rows[0].id, state: existing.rows[0].resulting_state, replayed: true }
          : { status: 'conflict' };
      }
      const evidence = await client.query<EvidenceRow>(`SELECT id, state, checksum_sha256, verified_at FROM policy.evidence_metadata e WHERE e.claim_id = $1 AND e.state = 'verified' AND e.retention_until > now()
        AND NOT EXISTS (SELECT 1 FROM policy.claim_requirement_files rf WHERE rf.evidence_id=e.id AND NOT rf.included)`, [claimId]);
      const verified = evidence.rows.filter(item => item.state === 'verified');
      if (input.evidenceIds.some(id => !verified.some(item => item.id === id))) {
        await client.query('ROLLBACK');
        return { status: 'invalid_evidence' };
      }
      const next = decisionState({ state: row.status, assigneeId: row.assignee_id, actorId: actor.clientId,
        requiredEvidence: row.evidence_required, verifiedEvidence: verified.length }, input);
      if (next !== 'approved' && next !== 'rejected') {
        await client.query('ROLLBACK');
        return { status: 'conflict' };
      }
      await this.checkLease(client, actor.expiresAt);
      const decisionId = crypto.randomUUID();
      const capture = { schemaVersion: 1, contractVersion: 'v1', correlationId: actor.traceId,
        inputs: { claimId, actorId: actor.clientId, priorState: row.status, action: input.action, reasonSha256: await digest(input.reason),
          evidence: input.evidenceIds.map(id => {
            const item = verified.find(row => row.id === id);
            if (!item || !item.verified_at) throw new Error('verified_evidence_missing');
            return { id, checksumSha256: item.checksum_sha256, verifiedAt: item.verified_at.toISOString() };
          }), requiredEvidence: row.evidence_required, verifiedEvidence: verified.length }, sources: [],
        consent: { status: 'not_required' }, rule: { id: 'assigned-claim-decision', version: '1' }, outcome: next };
      await client.query(`INSERT INTO policy.claim_decisions (id, claim_id, actor_id, idempotency_key_hash, request_hash, action,
        previous_state, resulting_state, reason, evidence_ids, decision_capture, correlation_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::JSONB,$11::JSONB,$12)`,
      [decisionId, claimId, actor.clientId, keyHash, requestHash, input.action, row.status, next, input.reason,
        JSON.stringify(input.evidenceIds), JSON.stringify(capture), actor.traceId]);
      await client.query(`UPDATE policy.claims SET status = $2, version = version + 1, updated_at = now(), correlation_id = $3 WHERE id = $1`,
        [claimId, next, actor.traceId]);
      await client.query(`INSERT INTO policy.audit_events (actor_reference, action, resource_type, resource_id, outcome, correlation_id, retention_until)
        VALUES ($1, 'claims.decision', 'claim', $2, $3, $4, now() + INTERVAL '90 days')`,
      [actor.clientId, claimId, next, actor.traceId]);
      await client.query(`INSERT INTO policy.outbox_events (event_id, aggregate_type, aggregate_id, event_type, event_version, payload, correlation_id)
        VALUES ($1, 'claim', $2, 'claim.decided', 1, $3::JSONB, $4)`,
      [crypto.randomUUID(), claimId, JSON.stringify({ claimId, decisionId, state: next }), actor.traceId]);
      await addClaimNotices(client, decisionId, claimId, input.action, row.subject_token, actor.clientId);
      await this.checkLease(client, actor.expiresAt);
      await client.query('COMMIT');
      return { status: 'ok', decisionId, state: next, replayed: false };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { await client.end().catch(() => {}); }
  }

  private async checkLease(db: Client, expiresAt: string) {
    if ((await db.query('SELECT 1 WHERE clock_timestamp() < $1::TIMESTAMPTZ', [expiresAt])).rowCount !== 1)
      throw new Error('claims_authorization_expired');
  }
}
