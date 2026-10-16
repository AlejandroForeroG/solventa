import { Client } from 'pg';
import { FINANCIAL_RULE, InvalidFinancialRecord, isAcceptedOffer } from '../../domain/financial';
import type { FinancialErrorCode, PolicyStatus, PolicyView } from '../../domain/financial';
import type { Command, FinancialStore, FinancialTransaction, Inbox, Payment, StoredPolicy } from '../../application/ports/financial';

type PolicyRow = { id: string; subject_token: string; status: PolicyStatus; premium: string; currency: string;
  offer_id: string; offer_version: string; effective_from: Date; effective_until: Date; client_id: string;
  terms: unknown; terms_hash: string; document: string; document_hash: string; coverage_snapshot: unknown };
const selectPolicy = `SELECT p.id,p.subject_token,p.status,p.premium::STRING,p.currency,p.offer_id,p.offer_version::STRING,
  p.effective_from,p.effective_until,p.coverage_snapshot,f.client_id,f.terms,f.terms_hash,f.document,f.document_hash
  FROM policy.policies p JOIN policy.financial_contracts f ON f.policy_id=p.id`;
const policyFrom = (row: PolicyRow): StoredPolicy => {
  if (!isAcceptedOffer(row.terms) || !['pending', 'charged', 'issued', 'refunding', 'refunded'].includes(row.status)) throw new InvalidFinancialRecord();
  return { id: row.id, clientId: row.client_id, subjectToken: row.subject_token, status: row.status, offer: row.terms,
    termsHash: row.terms_hash, document: row.document, documentHash: row.document_hash, premium: row.premium,
    currency: row.currency, offerId: row.offer_id, offerVersion: Number(row.offer_version), effectiveFrom: row.effective_from.toISOString(), effectiveUntil: row.effective_until.toISOString(), coverageSnapshot: row.coverage_snapshot };
};
type PaymentRow = { id: string; policy_id: string; operation: Payment['operation']; amount: string; currency: 'COP';
  idempotency_key: string; request_hash: string; status: Payment['status']; provider_reference: string | null;
  intent_id: string; intent_operation: string; intent_key: string; intent_hash: string };

class SqlFinancialTransaction implements FinancialTransaction {
  constructor(private readonly db: Client) {}
  async policy(id: string): Promise<StoredPolicy | null> {
    const row = (await this.db.query<PolicyRow>(selectPolicy + ' WHERE p.id=$1 FOR UPDATE OF p', [id])).rows[0];
    return row ? policyFrom(row) : null;
  }
  async acceptedPolicy(id: string): Promise<StoredPolicy | null> {
    const row = (await this.db.query<PolicyRow>(selectPolicy + ' WHERE f.acceptance_id=$1 FOR UPDATE OF p', [id])).rows[0];
    return row ? policyFrom(row) : null;
  }
  async offeredPolicy(offerId: string, offerVersion: number): Promise<StoredPolicy | null> {
    const row = (await this.db.query<PolicyRow>(selectPolicy + " WHERE f.terms->>'offerId'=$1 AND f.terms->>'offerVersion'=$2 FOR UPDATE OF p", [offerId, String(offerVersion)])).rows[0];
    return row ? policyFrom(row) : null;
  }
  async createPolicy(policy: StoredPolicy, eventId: string, traceId: string): Promise<void> {
    const offer = policy.offer;
    await this.db.query(`INSERT INTO policy.policies(id,subject_token,offer_id,offer_version,idempotency_key,request_hash,status,premium,currency,coverage_snapshot,effective_from,effective_until,correlation_id)
      VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10,$11,$12)`, [policy.id, policy.subjectToken, policy.offerId, policy.offerVersion,
      offer.acceptanceId, policy.termsHash, policy.premium, policy.currency, JSON.stringify(offer.coverage), policy.effectiveFrom, policy.effectiveUntil, traceId]);
    const capture = { schemaVersion: 1, contractVersion: 'v1', correlationId: traceId,
      inputs: { acceptanceId: offer.acceptanceId, offerId: offer.offerId, offerVersion: offer.offerVersion, premium: offer.premium, currency: offer.currency, coverage: offer.coverage, synthetic: true },
      sources: [], consent: { status: 'not_required' }, rule: { id: 'accepted-offer-import', version: FINANCIAL_RULE }, outcome: 'pending' };
    await this.db.query(`INSERT INTO policy.financial_contracts(policy_id,client_id,acceptance_id,acceptance_event_id,terms,terms_hash,document,document_hash,decision_capture)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [policy.id, policy.clientId, offer.acceptanceId, eventId, JSON.stringify(offer), policy.termsHash, policy.document, policy.documentHash, JSON.stringify(capture)]);
  }
  async setPolicyStatus(id: string, status: PolicyStatus): Promise<void> {
    await this.db.query('UPDATE policy.policies SET status=$2,version=version+1,updated_at=now() WHERE id=$1', [id, status]);
  }
  async command(actorId: string, key: string): Promise<Command | null> {
    const row = (await this.db.query<{ policy_id: string; request_hash: string; result: PolicyView | null }>('SELECT policy_id,request_hash,result FROM policy.financial_commands WHERE actor_id=$1 AND idempotency_key=$2', [actorId, key])).rows[0];
    return row ? { policyId: row.policy_id, requestHash: row.request_hash, result: row.result } : null;
  }
  async createCommand(actorId: string, key: string, policyId: string, requestHash: string): Promise<void> {
    await this.db.query('INSERT INTO policy.financial_commands(actor_id,idempotency_key,policy_id,request_hash) VALUES($1,$2,$3,$4)', [actorId, key, policyId, requestHash]);
  }
  async finishCommand(actorId: string, key: string, result: PolicyView): Promise<void> {
    await this.db.query('UPDATE policy.financial_commands SET result=$3 WHERE actor_id=$1 AND idempotency_key=$2', [actorId, key, JSON.stringify(result)]);
  }
  async payment(policyId: string, operation: Payment['operation']): Promise<Payment | null> {
    const row = (await this.db.query<PaymentRow>(`SELECT p.id,p.policy_id,p.operation,p.amount::STRING,p.currency,p.idempotency_key,p.request_hash,p.status,p.provider_reference,
      i.payment_id AS intent_id,i.operation AS intent_operation,i.payment_key AS intent_key,i.request_hash AS intent_hash
      FROM policy.financial_payment_intents i LEFT JOIN policy.payments p ON p.id=i.payment_id WHERE i.policy_id=$1 AND i.operation=$2`, [policyId, operation])).rows[0];
    if (row && (!row.id || row.id !== row.intent_id || row.policy_id !== policyId || row.operation !== row.intent_operation
      || row.idempotency_key !== row.intent_key || row.request_hash !== row.intent_hash
      || !['pending', 'confirmed', 'refunded', 'declined'].includes(row.status))) throw new InvalidFinancialRecord();
    if (!row && (await this.db.query<{ orphan: boolean }>(`SELECT EXISTS(SELECT 1 FROM policy.payments p
      LEFT JOIN policy.financial_payment_intents i ON i.payment_id=p.id WHERE p.policy_id=$1 AND i.payment_id IS NULL) AS orphan`, [policyId])).rows[0].orphan) throw new InvalidFinancialRecord();
    return row ? { id: row.id, policyId: row.policy_id, operation: row.operation, amount: row.amount, currency: row.currency,
      key: row.idempotency_key, hash: row.request_hash, status: row.status, providerReference: row.provider_reference } : null;
  }
  async createPayment(payment: Payment, traceId: string, claim?: { id: string; indemnityId: string; occurredAt: string }): Promise<void> {
    if (claim) {
      await this.db.query(`INSERT INTO policy.claims(id,policy_id,idempotency_key,request_hash,status,occurred_at,correlation_id)
        VALUES($1,$2,'parametric-once',$3,'approved',$4,$5)`, [claim.id, payment.policyId, payment.hash, claim.occurredAt, traceId]);
      await this.db.query(`INSERT INTO policy.indemnities(id,claim_id,policy_id,amount,currency,status,correlation_id)
        VALUES($1,$2,$3,$4,'COP','pending',$5)`, [claim.indemnityId, claim.id, payment.policyId, payment.amount, traceId]);
    }
    await this.db.query(`INSERT INTO policy.payments(id,policy_id,indemnity_id,operation,idempotency_key,request_hash,amount,currency,status,correlation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)`, [payment.id, payment.policyId, claim?.indemnityId ?? null, payment.operation, payment.key, payment.hash, payment.amount, payment.currency, traceId]);
    await this.db.query(`INSERT INTO policy.financial_payment_intents(policy_id,operation,payment_id,payment_key,request_hash)
      VALUES($1,$2,$3,$4,$5)`, [payment.policyId, payment.operation, payment.id, payment.key, payment.hash]);
  }
  async setPaymentStatus(id: string, status: Payment['status'], reference: string | null): Promise<void> {
    await this.db.query(`UPDATE policy.payments SET status=$2,provider='synthetic-gateway-v1',provider_reference=$3,version=version+1,updated_at=now() WHERE id=$1`, [id, status, reference]);
    if (status === 'confirmed') {
      await this.db.query(`UPDATE policy.indemnities SET status='paid' WHERE id IN (SELECT indemnity_id FROM policy.payments WHERE id=$1 AND operation='indemnity')`, [id]);
      await this.db.query(`UPDATE policy.claims SET status='paid',version=version+1,updated_at=now() WHERE id IN
        (SELECT claim_id FROM policy.indemnities WHERE id IN (SELECT indemnity_id FROM policy.payments WHERE id=$1 AND operation='indemnity'))`, [id]);
    }
  }
  async inbox(eventId: string, consumer: string): Promise<Inbox | null> {
    const row = (await this.db.query<{ payload_hash: string | null; policy_id: string | null; outcome: string }>('SELECT payload_hash,policy_id,outcome FROM policy.inbox_events WHERE event_id=$1 AND consumer=$2', [eventId, consumer])).rows[0];
    return row ? { hash: row.payload_hash, policyId: row.policy_id, outcome: row.outcome } : null;
  }
  async recordInbox(eventId: string, consumer: string, hash: string, policyId: string, eventType: string, traceId: string): Promise<void> {
    await this.db.query(`INSERT INTO policy.inbox_events(event_id,consumer,event_type,event_version,outcome,correlation_id,payload_hash,policy_id)
      VALUES($1,$2,$3,1,'accepted',$4,$5,$6)`, [eventId, consumer, eventType, traceId, hash, policyId]);
  }
  async signature(policyId: string): Promise<{ documentHash: string; receipt: string; signedAt: string; timeSeal: string | null } | null> {
    const row = (await this.db.query<{ document_hash: string; receipt: string; signed_at: Date; time_seal: string | null }>('SELECT document_hash,receipt,signed_at,time_seal FROM policy.policy_signatures WHERE policy_id=$1', [policyId])).rows[0];
    return row ? { documentHash: row.document_hash, receipt: row.receipt, signedAt: row.signed_at.toISOString(), timeSeal: row.time_seal } : null;
  }
  async recordSignature(policyId: string, documentHash: string, receipt: string, signedAt: string, timeSeal: string): Promise<void> {
    await this.db.query(`INSERT INTO policy.policy_signatures(policy_id,document_hash,provider,receipt,signed_at,time_seal)
      VALUES($1,$2,'synthetic-signature-v1',$3,$4,$5)`, [policyId, documentHash, receipt, signedAt, timeSeal]);
  }
  async audit(action: Parameters<FinancialTransaction['audit']>[0], resourceId: string, traceId: string, outcome: string, actorReference = 'unattributed'): Promise<void> {
    await this.db.query(`INSERT INTO policy.audit_events(actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
      VALUES($5,$1,'financial_decision',$2,$3,$4,now()+interval '90 days')`, [action, resourceId, outcome, traceId, actorReference]);
    const capture = { schemaVersion: 1, contractVersion: 'v1', correlationId: traceId, inputs: { resourceId, synthetic: true },
      sources: [], consent: { status: 'not_required' }, rule: { id: action, version: FINANCIAL_RULE }, outcome };
    await this.db.query(`INSERT INTO policy.outbox_events(event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id)
      VALUES(gen_random_uuid(),'financial_decision',$1,$2,1,$3,$4)`, [resourceId, 'policy.' + action, JSON.stringify(capture), traceId]);
  }
}

export class SqlFinancialStore implements FinancialStore {
  constructor(private readonly connectionString: string) {}
  async transaction<T>(work: (tx: FinancialTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 3000, query_timeout: 3000 });
      db.on('error', () => {});
      try {
        await db.connect(); await db.query('BEGIN');
        try { const result = await work(new SqlFinancialTransaction(db)); await db.query('COMMIT'); return result; }
        catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
      } catch (error) {
        const code = error && typeof error === 'object' && Object.hasOwn(error, 'code') ? Object.getOwnPropertyDescriptor(error, 'code')?.value : null;
        if (!['40001', '23505'].includes(code) || attempt >= 2) throw error;
      } finally { await db.end().catch(() => {}); }
    }
  }
  async rejection(id: string, traceId: string, cause: FinancialErrorCode): Promise<void> {
    await this.transaction(tx => tx.audit('financial.denied', id, traceId, cause));
  }
}
