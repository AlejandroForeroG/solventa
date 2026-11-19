import { Client } from 'pg';
import type { ClaimDecisionActor } from '../../application/claim-decisions';
import type { DisbursementCapture, DisbursementContext, DisbursementStore, DisbursementTransaction } from '../../application/ports/claim-disbursement';
import type { Payment } from '../../application/ports/financial';
import type { DisbursementState } from '../../domain/claim-disbursement';
import { addClaimNotices } from './sql-claim-notices';
import type { ReportOwner } from '../../application/ports/claim-report';
import { isLifecycleChange } from '../../domain/policy-lifecycle';

type Row = Omit<DisbursementContext, 'occurredAt' | 'issuedAt' | 'payment' | 'lifecycle'> & { occurredAt: Date; issuedAt: Date;
  lifecyclePayload: unknown; lifecycleId: string | null; lifecycleAt: Date | null; paymentId: string | null; amount: string | null;
  paymentStatus: Payment['status'] | null; paymentHash: string | null; paymentKey: string | null; reference: string | null; currency: string | null; claimNumber: string; paymentUpdatedAt: Date | null };

const contextSql = `SELECT c.claim_number AS "claimNumber",c.id AS "claimId",c.policy_id AS "policyId",c.status AS state,c.occurred_at AS "occurredAt",c.assignee_id AS "analystId",
  p.status AS "policyStatus",p.subject_token AS "ownerSubjectToken",d.id AS "decisionId",f.terms AS offer,f.terms_hash AS "termsHash",
  sig.signed_at AS "issuedAt",sig.receipt AS "signatureReceipt",sig.time_seal AS "timeSeal",sig.document_hash AS "documentHash",
  premium.status AS "premiumStatus",pay.id AS "paymentId",pay.amount::STRING AS amount,pay.currency,pay.status AS "paymentStatus",
  pay.request_hash AS "paymentHash",pay.idempotency_key AS "paymentKey",pay.provider_reference AS reference,pay.updated_at AS "paymentUpdatedAt",
  i.id AS "indemnityId",i.amount::STRING AS "indemnityAmount",lc.payload AS "lifecyclePayload",lc.change_id AS "lifecycleId",lc.occurred_at AS "lifecycleAt",
  (SELECT COALESCE(sum(other.amount),0)::DECIMAL(19,4)::STRING FROM policy.indemnities other
    WHERE other.policy_id=c.policy_id AND other.claim_id<>c.id AND other.status<>'declined') AS "reservedAmount"
  FROM policy.claims c JOIN policy.policies p ON p.id=c.policy_id
  JOIN policy.financial_contracts f ON f.policy_id=p.id
  JOIN policy.claim_decisions d ON d.claim_id=c.id AND d.action='approve' AND d.resulting_state='approved'
  JOIN policy.policy_signatures sig ON sig.policy_id=p.id AND sig.document_hash=f.document_hash
  JOIN policy.financial_payment_intents premium_intent ON premium_intent.policy_id=p.id AND premium_intent.operation='premium'
  JOIN policy.payments premium ON premium.id=premium_intent.payment_id
  LEFT JOIN policy.policy_lifecycle_changes lc ON lc.policy_id=p.id
  LEFT JOIN policy.payments pay ON pay.policy_id=p.id AND pay.operation='indemnity' AND pay.idempotency_key='approved-claim:'||d.id::STRING
  LEFT JOIN policy.indemnities i ON i.id=pay.indemnity_id AND i.claim_id=c.id AND i.policy_id=p.id
    AND i.amount=pay.amount AND i.currency=pay.currency AND i.status=CASE WHEN pay.status='confirmed' THEN 'paid' ELSE pay.status END`;

function context(row: Row | undefined): DisbursementContext | null {
  if (!row) return null;
  const lifecycle = row.lifecyclePayload;
  if (row.lifecycleId !== null && (!isLifecycleChange(lifecycle) || lifecycle.policyId !== row.policyId
    || lifecycle.changeId !== row.lifecycleId || !row.lifecycleAt || Date.parse(lifecycle.at) !== row.lifecycleAt.getTime()))
    throw Error('claim_disbursement_integrity');
  let payment: Payment | null = null;
  if (row.paymentId) {
    if (!row.amount || !row.paymentStatus || !row.paymentHash || !row.paymentKey || row.currency !== 'COP') throw Error('invalid_claim_payment');
    payment = { id: row.paymentId, policyId: row.policyId, operation: 'indemnity', amount: row.amount, status: row.paymentStatus,
      hash: row.paymentHash, key: row.paymentKey, currency: 'COP', providerReference: row.reference };
  }
  return { claimId: row.claimId, policyId: row.policyId, state: row.state, analystId: row.analystId,
    policyStatus: row.policyStatus, ownerSubjectToken: row.ownerSubjectToken, decisionId: row.decisionId,
    offer: row.offer, termsHash: row.termsHash, signatureReceipt: row.signatureReceipt, timeSeal: row.timeSeal,
    documentHash: row.documentHash, premiumStatus: row.premiumStatus, indemnityId: row.indemnityId,
    indemnityAmount: row.indemnityAmount, reservedAmount: row.reservedAmount,
    payment, lifecycle: isLifecycleChange(lifecycle) ? lifecycle : null,
    occurredAt: row.occurredAt.toISOString(), issuedAt: row.issuedAt.toISOString() };
}

class Transaction implements DisbursementTransaction {
  constructor(private readonly db: Client) {}

  async owned(owner: ReportOwner, traceId: string, cursor?: string) {
    const rows = (await this.db.query<Row>(contextSql
      + ` WHERE p.subject_token=$1 AND f.client_id=$2 AND c.submitted_at IS NOT NULL AND c.status IN ('approved','paid') AND pay.id IS NOT NULL
        AND ($3::UUID IS NULL OR c.id>$3::UUID) AND ($3::UUID IS NULL OR EXISTS (
          SELECT 1 FROM policy.claims boundary JOIN policy.policies owned ON owned.id=boundary.policy_id
          JOIN policy.financial_contracts contract ON contract.policy_id=owned.id
          WHERE boundary.id=$3 AND owned.subject_token=$1 AND contract.client_id=$2)) ORDER BY c.id LIMIT 7`,
    [owner.subjectToken, owner.clientId, cursor ?? null])).rows;
    await this.audit(owner.clientId, owner.clientId, traceId, 'claims.disbursement.owned', 'success');
    return rows.map(row => {
      const value = context(row); if (!value || !row.paymentUpdatedAt) throw Error('invalid_claim_payment');
      return { ...value, claimNumber: row.claimNumber, updatedAt: row.paymentUpdatedAt.toISOString() };
    });
  }

  async authorized(claimId: string, actor: ClaimDecisionActor) {
    const row = (await this.db.query<Row>(contextSql + ` WHERE c.id=$1 AND c.assignee_id=$2 AND p.subject_token<>$3 AND f.client_id<>$2
      AND c.submitted_at IS NOT NULL AND c.status IN ('approved','paid') FOR UPDATE OF c,p`, [claimId, actor.clientId, actor.subjectToken])).rows[0];
    await this.audit(actor.clientId, claimId, actor.traceId, 'claims.disbursement.read', row ? 'success' : 'not_found');
    return context(row);
  }

  async pending(paymentId: string) {
    return context((await this.db.query<Row>(contextSql + ' WHERE pay.id=$1 FOR UPDATE OF c,p', [paymentId])).rows[0]);
  }

  async create(value: DisbursementContext, payment: Payment, indemnityId: string, actor: ClaimDecisionActor, capture: DisbursementCapture) {
    // The existing per-policy/operation/key uniqueness binds this intent to its immutable approval.
    await this.db.query(`INSERT INTO policy.indemnities (id,claim_id,policy_id,amount,currency,status,correlation_id)
      VALUES ($1,$2,$3,$4,'COP','pending',$5)`, [indemnityId, value.claimId, value.policyId, payment.amount, actor.traceId]);
    await this.db.query(`INSERT INTO policy.payments (id,policy_id,indemnity_id,operation,idempotency_key,request_hash,amount,currency,status,correlation_id)
      VALUES ($1,$2,$3,'indemnity',$4,$5,$6,'COP','pending',$7)`,
    [payment.id, payment.policyId, indemnityId, payment.key, payment.hash, payment.amount, actor.traceId]);
    await this.audit(actor.clientId, payment.id, actor.traceId, 'claims.disbursement.requested', 'pending');
    await this.outbox(value.claimId, actor.traceId, 'claim.disbursement.requested', capture);
  }

  async finish(value: DisbursementContext, status: Exclude<DisbursementState, 'pending'>, reference: string | null, traceId: string, capture: DisbursementCapture) {
    if (!value.payment || !value.indemnityId) throw Error('claim_payment_intent_missing');
    const updated = await this.db.query(`UPDATE policy.payments SET status=$2,provider='synthetic-payment-gateway-v1',provider_reference=$3,
      updated_at=now(),version=version+1,correlation_id=$4 WHERE id=$1 AND status='pending' RETURNING id`, [value.payment.id, status, reference, traceId]);
    if (updated.rowCount !== 1) throw Error('claim_payment_concurrent_transition');
    await this.db.query('UPDATE policy.indemnities SET status=$2,correlation_id=$3 WHERE id=$1',
      [value.indemnityId, status === 'confirmed' ? 'paid' : 'declined', traceId]);
    if (status === 'confirmed') await this.db.query(`UPDATE policy.claims SET status='paid',version=version+1,updated_at=now(),correlation_id=$2
      WHERE id=$1 AND status='approved'`, [value.claimId, traceId]);
    await this.audit('claim-disbursement-recovery-v1', value.payment.id, traceId, 'claims.disbursement.' + status, status);
    await this.outbox(value.claimId, traceId, 'claim.disbursement.' + status, capture);
    await addClaimNotices(this.db, value.payment.id, value.claimId, status === 'confirmed' ? 'disbursement_confirmed' : 'disbursement_declined',
      value.ownerSubjectToken, value.analystId);
  }

  private audit(actor: string, resourceId: string, traceId: string, action: string, outcome: string) {
    return this.db.query(`INSERT INTO policy.audit_events(actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
      VALUES($1,$2,'claim_disbursement',$3,$4,$5,now()+INTERVAL '90 days')`, [actor, action, resourceId, outcome, traceId]);
  }
  private outbox(claimId: string, traceId: string, type: string, capture: DisbursementCapture) {
    return this.db.query(`INSERT INTO policy.outbox_events(event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id)
      VALUES(gen_random_uuid(),'claim',$1,$2,1,$3::JSONB,$4)`, [claimId, type, JSON.stringify(capture), traceId]);
  }
}

export class SqlClaimDisbursements implements DisbursementStore {
  constructor(private readonly connectionString: string) {}
  async transaction<T>(work: (tx: DisbursementTransaction) => Promise<T>, actor?: ClaimDecisionActor): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1500, query_timeout: 1500 });
      db.on('error', () => {});
      try {
        await db.connect(); await db.query('BEGIN');
        if (actor) await this.lease(db, actor.expiresAt);
        const result = await work(new Transaction(db));
        if (actor) await this.lease(db, actor.expiresAt);
        await db.query('COMMIT'); return result;
      } catch (error) {
        await db.query('ROLLBACK').catch(() => {});
        if (attempt === 0 && error instanceof Error && 'code' in error && (error.code === '40001' || error.code === '23505')) continue;
        throw error;
      } finally { await db.end().catch(() => {}); }
    }
  }

  async candidates(limit: number): Promise<string[]> {
    const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1500, query_timeout: 1500 });
    db.on('error', () => {});
    try {
      await db.connect();
      const result = await db.query<{ id: string }>(`UPDATE policy.payments SET updated_at=clock_timestamp() WHERE id IN (
        SELECT pay.id FROM policy.payments pay JOIN policy.indemnities i ON i.id=pay.indemnity_id
        JOIN policy.claim_decisions d ON d.claim_id=i.claim_id AND d.action='approve' AND d.resulting_state='approved'
        WHERE pay.operation='indemnity' AND pay.status='pending' AND pay.idempotency_key='approved-claim:'||d.id::STRING
        ORDER BY pay.updated_at,pay.id LIMIT $1) RETURNING id`, [limit]);
      return result.rows.map(row => row.id);
    } finally { await db.end().catch(() => {}); }
  }

  private async lease(db: Client, expiresAt: string) {
    if ((await db.query('SELECT 1 WHERE clock_timestamp()<$1::TIMESTAMPTZ', [expiresAt])).rowCount !== 1) throw Error('claims_authorization_expired');
  }
}
