import { Client } from 'pg';
import { InvalidFinancialRecord, isAcceptedOffer } from '../../domain/financial';
import type { FinancialDecisionCapture } from '../../application/financial-decision';
import type { FinancialActor, FinancialErrorCode, PolicyStatus, PolicyView } from '../../domain/financial';
import type { AcceptanceImport, AcceptedPolicyLookup, Command, FinancialStore, FinancialTransaction, ImportedEvent, Inbox, IssuanceCommit, Payment, PolicyRecord, PremiumStart, Signature, StoredPolicy } from '../../application/ports/financial';

type PolicyRow = { id: string; subject_token: string; status: PolicyStatus; premium: string; currency: string;
  offer_id: string; offer_version: string; effective_from: Date; effective_until: Date; client_id: string;
  terms: unknown; terms_hash: string; document: string; document_hash: string; coverage_snapshot: unknown };
const policyFrom = (row: PolicyRow): StoredPolicy => {
  if (!isAcceptedOffer(row.terms) || !['pending', 'charged', 'issued', 'refunding', 'refunded'].includes(row.status)) throw new InvalidFinancialRecord();
  return { id: row.id, clientId: row.client_id, subjectToken: row.subject_token, status: row.status, offer: row.terms,
    termsHash: row.terms_hash, document: row.document, documentHash: row.document_hash, premium: row.premium,
    currency: row.currency, offerId: row.offer_id, offerVersion: Number(row.offer_version), effectiveFrom: row.effective_from.toISOString(), effectiveUntil: row.effective_until.toISOString(), coverageSnapshot: row.coverage_snapshot };
};
type PaymentRow = { payment_id: string | null; payment_policy_id: string | null; payment_operation: Payment['operation'] | null; payment_amount: string | null;
  payment_currency: 'COP' | null; payment_key: string | null; payment_hash: string | null; payment_status: Payment['status'] | null; payment_reference: string | null;
  intent_id: string | null; intent_operation: string | null; intent_key: string | null; intent_hash: string | null; orphan: boolean };
const paymentColumns = (intent: string, payment: string, policyId: string) => `${payment}.id AS payment_id,${payment}.policy_id AS payment_policy_id,
  ${payment}.operation AS payment_operation,${payment}.amount::STRING AS payment_amount,${payment}.currency AS payment_currency,
  ${payment}.idempotency_key AS payment_key,${payment}.request_hash AS payment_hash,${payment}.status AS payment_status,${payment}.provider_reference AS payment_reference,
  ${intent}.payment_id AS intent_id,${intent}.operation AS intent_operation,${intent}.payment_key AS intent_key,${intent}.request_hash AS intent_hash,
  (${intent}.payment_id IS NULL AND EXISTS(SELECT 1 FROM policy.payments other
    LEFT JOIN policy.financial_payment_intents unbound ON unbound.payment_id=other.id
    WHERE other.policy_id=${policyId} AND unbound.payment_id IS NULL)) AS orphan`;
const paymentFrom = (row: PaymentRow, policyId: string, operation: Payment['operation']): Payment | null => {
  if (row.orphan !== false) throw new InvalidFinancialRecord();
  if (row.intent_id === null) return null;
  if (!row.payment_id || row.payment_id !== row.intent_id || row.payment_policy_id !== policyId || row.payment_operation !== operation
    || row.payment_operation !== row.intent_operation || typeof row.payment_amount !== 'string' || row.payment_currency !== 'COP'
    || typeof row.payment_key !== 'string' || typeof row.payment_hash !== 'string' || row.payment_key !== row.intent_key || row.payment_hash !== row.intent_hash
    || !row.payment_status || !['pending', 'confirmed', 'refunded', 'declined'].includes(row.payment_status)) throw new InvalidFinancialRecord();
  return { id: row.payment_id, policyId: row.payment_policy_id, operation: row.payment_operation, amount: row.payment_amount, currency: row.payment_currency,
    key: row.payment_key, hash: row.payment_hash, status: row.payment_status, providerReference: row.payment_reference };
};
type RecordRow = PolicyRow & PaymentRow & { signature_policy_id: string | null; signature_document_hash: string | null;
  signature_receipt: string | null; signature_signed_at: Date | null; signature_time_seal: string | null };
// The (policy_id, operation) intent key and the policy_id signature key keep this join to one row per policy.
const selectRecord = (extraColumns = '', extraJoins = '') => `SELECT p.id,p.subject_token,p.status,p.premium::STRING AS premium,p.currency,p.offer_id,p.offer_version::STRING AS offer_version,
  p.effective_from,p.effective_until,p.coverage_snapshot,f.client_id,f.terms,f.terms_hash,f.document,f.document_hash,
  ${paymentColumns('i', 'pay', 'p.id')},
  s.policy_id AS signature_policy_id,s.document_hash AS signature_document_hash,s.receipt AS signature_receipt,
  s.signed_at AS signature_signed_at,s.time_seal AS signature_time_seal ${extraColumns}
  FROM policy.policies p JOIN policy.financial_contracts f ON f.policy_id=p.id
  LEFT JOIN policy.financial_payment_intents i ON i.policy_id=p.id AND i.operation='premium'
  LEFT JOIN policy.payments pay ON pay.id=i.payment_id
  LEFT JOIN policy.policy_signatures s ON s.policy_id=p.id ${extraJoins}`;
const recordFrom = (rows: RecordRow[]): PolicyRecord | null => {
  if (rows.length > 1) throw new InvalidFinancialRecord();
  const row = rows[0];
  if (!row) return null;
  const policy = policyFrom(row), premium = paymentFrom(row, policy.id, 'premium');
  if (row.signature_policy_id === null) return { policy, premium, signature: null };
  if (row.signature_policy_id !== policy.id || row.signature_document_hash === null || row.signature_receipt === null || row.signature_signed_at === null) throw new InvalidFinancialRecord();
  return { policy, premium, signature: { documentHash: row.signature_document_hash, receipt: row.signature_receipt,
    signedAt: row.signature_signed_at.toISOString(), timeSeal: row.signature_time_seal } };
};

class SqlFinancialTransaction implements FinancialTransaction {
  constructor(private readonly db: Client) {}
  async policy(id: string, actor?: FinancialActor): Promise<PolicyRecord | null> {
    const owned = actor ? ' AND f.client_id=$2 AND p.subject_token=$3' : '';
    return recordFrom((await this.db.query<RecordRow>(selectRecord() + ' WHERE p.id=$1' + owned + ' FOR UPDATE OF p',
      actor ? [id, actor.clientId, actor.subjectToken] : [id])).rows);
  }
  async issuanceSnapshot(id: string, actor: FinancialActor, commandKey: string): Promise<{ record: PolicyRecord | null; command: Command | null }> {
    const rows = (await this.db.query<RecordRow & { command_policy_id: string | null; command_hash: string | null; command_result: PolicyView | null }>(
      selectRecord(',cmd.policy_id AS command_policy_id,cmd.request_hash AS command_hash,cmd.result AS command_result',
        'LEFT JOIN policy.financial_commands cmd ON cmd.actor_id=$2 AND cmd.idempotency_key=$4')
      + ' WHERE p.id=$1 AND f.client_id=$2 AND p.subject_token=$3 FOR UPDATE OF p', [id, actor.clientId, actor.subjectToken, commandKey])).rows;
    const record = recordFrom(rows), row = rows[0];
    if (!record || !row || row.command_policy_id === null) return { record, command: null };
    if (typeof row.command_hash !== 'string') throw new InvalidFinancialRecord();
    return { record, command: { policyId: row.command_policy_id, requestHash: row.command_hash, result: row.command_result } };
  }
  async beginPremium(input: PremiumStart): Promise<void> {
    const { policy, payment, command, traceId, capture } = input;
    if (policy.status !== 'pending' || payment.policyId !== policy.id || payment.operation !== 'premium' || payment.status !== 'pending') throw new InvalidFinancialRecord();
    const result = await this.db.query(`WITH commanded AS (
      INSERT INTO policy.financial_commands(actor_id,idempotency_key,policy_id,request_hash)
      SELECT $9::UUID,$10,$2,$11 WHERE $12 RETURNING policy_id
    ), created AS (
      INSERT INTO policy.payments(id,policy_id,operation,idempotency_key,request_hash,amount,currency,status,correlation_id)
      SELECT $1,$2,'premium',$3,$4,$5,$6,'pending',$7 WHERE NOT $12 OR EXISTS(SELECT 1 FROM commanded) RETURNING id
    ), intended AS (
      INSERT INTO policy.financial_payment_intents(policy_id,operation,payment_id,payment_key,request_hash)
      SELECT $2,'premium',id,$3,$4 FROM created RETURNING policy_id
    ), audited AS (
      INSERT INTO policy.audit_events(actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
      SELECT $9::STRING,'premium.requested','financial_decision',policy_id,'pending',$7,now()+interval '90 days' FROM intended RETURNING resource_id,correlation_id
    ) INSERT INTO policy.outbox_events(event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id)
      SELECT gen_random_uuid(),'financial_decision',resource_id,'policy.premium.requested',1,$8,correlation_id FROM audited`,
    [payment.id, policy.id, payment.key, payment.hash, payment.amount, payment.currency, traceId, JSON.stringify(capture),
      policy.clientId, command?.key ?? '', command?.requestHash ?? '', command !== null]);
    if (result.rowCount !== 1) throw new Error('financial_premium_intent_incomplete');
  }
  async setPolicyStatus(id: string, status: PolicyStatus): Promise<void> {
    await this.db.query('UPDATE policy.policies SET status=$2,version=version+1,updated_at=now() WHERE id=$1', [id, status]);
  }
  async createCommand(actorId: string, key: string, policyId: string, requestHash: string): Promise<void> {
    await this.db.query('INSERT INTO policy.financial_commands(actor_id,idempotency_key,policy_id,request_hash) VALUES($1,$2,$3,$4)', [actorId, key, policyId, requestHash]);
  }
  async finishCommand(actorId: string, key: string, result: PolicyView): Promise<void> {
    await this.db.query('UPDATE policy.financial_commands SET result=$3 WHERE actor_id=$1 AND idempotency_key=$2', [actorId, key, JSON.stringify(result)]);
  }
  async payment(policyId: string, operation: Payment['operation']): Promise<Payment | null> {
    const row = (await this.db.query<PaymentRow>(`SELECT ${paymentColumns('i', 'p', '$1')}
      FROM (SELECT 1) anchor LEFT JOIN policy.financial_payment_intents i ON i.policy_id=$1 AND i.operation=$2
      LEFT JOIN policy.payments p ON p.id=i.payment_id`, [policyId, operation])).rows[0];
    if (!row) throw new InvalidFinancialRecord();
    return paymentFrom(row, policyId, operation);
  }
  async createPayment(payment: Payment, traceId: string, claim?: { id: string; indemnityId: string; occurredAt: string }): Promise<void> {
    if (claim) {
      await this.db.query(`INSERT INTO policy.claims(id,policy_id,idempotency_key,request_hash,status,occurred_at,correlation_id)
        VALUES($1,$2,'parametric-once',$3,'approved',$4,$5)`, [claim.id, payment.policyId, payment.hash, claim.occurredAt, traceId]);
      await this.db.query(`INSERT INTO policy.indemnities(id,claim_id,policy_id,amount,currency,status,correlation_id)
        VALUES($1,$2,$3,$4,'COP','pending',$5)`, [claim.indemnityId, claim.id, payment.policyId, payment.amount, traceId]);
    }
    await this.db.query(`WITH created AS (
      INSERT INTO policy.payments(id,policy_id,indemnity_id,operation,idempotency_key,request_hash,amount,currency,status,correlation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9) RETURNING id
    ) INSERT INTO policy.financial_payment_intents(policy_id,operation,payment_id,payment_key,request_hash)
      SELECT $2,$4,id,$5,$6 FROM created`, [payment.id, payment.policyId, claim?.indemnityId ?? null, payment.operation, payment.key, payment.hash, payment.amount, payment.currency, traceId]);
  }
  async setPaymentStatus(id: string, status: Payment['status'], reference: string | null): Promise<void> {
    if (status === 'confirmed') {
      await this.db.query(`WITH confirmed AS (
        UPDATE policy.payments SET status=$2,provider='synthetic-gateway-v1',provider_reference=$3,version=version+1,updated_at=now()
        WHERE id=$1 RETURNING indemnity_id,operation
      ), paid AS (
        UPDATE policy.indemnities SET status='paid' WHERE id IN
          (SELECT indemnity_id FROM confirmed WHERE operation='indemnity') RETURNING claim_id
      ) UPDATE policy.claims SET status='paid',version=version+1,updated_at=now()
        WHERE id IN (SELECT claim_id FROM paid)`, [id, status, reference]);
    } else await this.db.query(`UPDATE policy.payments SET status=$2,provider='synthetic-gateway-v1',provider_reference=$3,version=version+1,updated_at=now() WHERE id=$1`, [id, status, reference]);
  }
  async inbox(eventId: string, consumer: string): Promise<Inbox | null> {
    const row = (await this.db.query<{ payload_hash: string | null; policy_id: string | null; outcome: string }>('SELECT payload_hash,policy_id,outcome FROM policy.inbox_events WHERE event_id=$1 AND consumer=$2', [eventId, consumer])).rows[0];
    return row ? { hash: row.payload_hash, policyId: row.policy_id, outcome: row.outcome } : null;
  }
  async recordInbox(eventId: string, consumer: string, hash: string, policyId: string, eventType: string, traceId: string): Promise<void> {
    await this.db.query(`INSERT INTO policy.inbox_events(event_id,consumer,event_type,event_version,outcome,correlation_id,payload_hash,policy_id)
      VALUES($1,$2,$3,1,'accepted',$4,$5,$6)`, [eventId, consumer, eventType, traceId, hash, policyId]);
  }
  async confirmPremium(policy: StoredPolicy, payment: Payment, traceId: string, capture: FinancialDecisionCapture): Promise<void> {
    if (policy.status !== 'pending' || payment.policyId !== policy.id || payment.operation !== 'premium'
      || payment.status !== 'confirmed' || !payment.providerReference) throw new InvalidFinancialRecord();
    const result = await this.db.query(`WITH confirmed AS (
      UPDATE policy.payments SET status='confirmed',provider='synthetic-gateway-v1',provider_reference=$3,version=version+1,updated_at=now()
      WHERE id=$1 AND policy_id=$2 AND operation='premium' AND status='pending'
        AND EXISTS(SELECT 1 FROM policy.financial_payment_intents i WHERE i.policy_id=$2 AND i.operation='premium' AND i.payment_id=$1)
      RETURNING policy_id
    ), charged AS (
      UPDATE policy.policies SET status='charged',version=version+1,updated_at=now()
      WHERE id IN (SELECT policy_id FROM confirmed) AND status='pending' RETURNING id
    ), audited AS (
      INSERT INTO policy.audit_events(actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
      SELECT $5,'premium.confirmed','financial_decision',id,'confirmed',$4,now()+interval '90 days' FROM charged RETURNING resource_id,correlation_id
    ) INSERT INTO policy.outbox_events(event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id)
      SELECT gen_random_uuid(),'financial_decision',resource_id,'policy.premium.confirmed',1,$6,correlation_id FROM audited`,
    [payment.id, policy.id, payment.providerReference, traceId, policy.clientId, JSON.stringify(capture)]);
    if (result.rowCount !== 1) throw new Error('financial_confirmation_incomplete');
  }
  async completeIssuance(input: IssuanceCommit): Promise<Signature> {
    const { policy, signature, commandKey, result: response, capture, traceId } = input;
    if (policy.status !== 'charged') throw new InvalidFinancialRecord();
    const result = await this.db.query<{ document_hash: string; receipt: string; signed_at: Date; time_seal: string }>(
      `WITH signed AS (
        INSERT INTO policy.policy_signatures(policy_id,document_hash,provider,receipt,signed_at,time_seal)
        VALUES($1,$2,'synthetic-signature-v1',$3,$4,$5) RETURNING policy_id,document_hash,receipt,signed_at,time_seal
      ), issued AS (
        UPDATE policy.policies SET status='issued',version=version+1,updated_at=now()
        WHERE id IN (SELECT policy_id FROM signed) AND status='charged' RETURNING id
      ), audited AS (
        INSERT INTO policy.audit_events(actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
        SELECT $7,'policy.issued','financial_decision',id,'issued',$6,now()+interval '90 days' FROM issued RETURNING resource_id,correlation_id
      ), evented AS (
        INSERT INTO policy.outbox_events(event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id)
        SELECT gen_random_uuid(),'financial_decision',resource_id,'policy.policy.issued',1,$8,correlation_id FROM audited RETURNING aggregate_id
      ), completed AS (
        UPDATE policy.financial_commands SET result=$11
        WHERE actor_id=$9 AND idempotency_key=$10 AND policy_id IN (SELECT aggregate_id FROM evented) RETURNING policy_id
      ) SELECT s.document_hash,s.receipt,s.signed_at,s.time_seal FROM signed s JOIN completed c ON c.policy_id=s.policy_id`,
    [policy.id, signature.documentHash, signature.receipt, signature.signedAt, signature.timeSeal, traceId,
      policy.clientId, JSON.stringify(capture), policy.clientId, commandKey, JSON.stringify(response)]);
    const row = result.rows[0];
    if (result.rowCount !== 1 || !row) throw new Error('financial_issuance_evidence_missing');
    return { documentHash: row.document_hash, receipt: row.receipt, signedAt: row.signed_at.toISOString(), timeSeal: row.time_seal };
  }
  async audit(action: Parameters<FinancialTransaction['audit']>[0], resourceId: string, traceId: string, outcome: string, actorReference: string, capture: FinancialDecisionCapture): Promise<void> {
    await this.db.query(`WITH audited AS (
      INSERT INTO policy.audit_events(actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
      VALUES($5,$1,'financial_decision',$2,$3,$4,now()+interval '90 days') RETURNING correlation_id
    ) INSERT INTO policy.outbox_events(event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id)
      SELECT gen_random_uuid(),'financial_decision',$2,$6,1,$7,correlation_id FROM audited`,
    [action, resourceId, outcome, traceId, actorReference, 'policy.' + action, JSON.stringify(capture)]);
  }
}

export class SqlFinancialStore implements FinancialStore {
  constructor(private readonly connectionString: string) {}
  private async connection<T>(work: (db: Client) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 3000, query_timeout: 3000 });
      db.on('error', () => {});
      try {
        await db.connect(); return await work(db);
      } catch (error) {
        const code = error && typeof error === 'object' && Object.hasOwn(error, 'code') ? Object.getOwnPropertyDescriptor(error, 'code')?.value : null;
        if (!['40001', '23505'].includes(code) || attempt >= 2) throw error;
      } finally { await db.end().catch(() => {}); }
    }
  }
  async transaction<T>(work: (tx: FinancialTransaction) => Promise<T>): Promise<T> {
    return this.connection(async db => {
      await db.query('BEGIN');
      try { const result = await work(new SqlFinancialTransaction(db)); await db.query('COMMIT'); return result; }
      catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
    });
  }
  readPolicy(id: string, actor: FinancialActor): Promise<PolicyRecord | null> {
    return this.connection(async db => recordFrom((await db.query<RecordRow>(selectRecord()
      + ' WHERE p.id=$1 AND f.client_id=$2 AND p.subject_token=$3', [id, actor.clientId, actor.subjectToken])).rows));
  }
  readAcceptedPolicy(id: string, actor: FinancialActor): Promise<AcceptedPolicyLookup> {
    return this.connection(async db => {
      // Only owned evidence is selected; existence of a foreign acceptance comes from the same statement snapshot.
      const rows = (await db.query<(RecordRow | { [K in keyof RecordRow]: null }) & { accepted: boolean }>(`WITH owned AS (${selectRecord()}
        WHERE f.acceptance_id=$1 AND f.client_id=$2 AND p.subject_token=$3)
        SELECT owned.*,EXISTS(SELECT 1 FROM policy.financial_contracts WHERE acceptance_id=$1) AS accepted
        FROM (SELECT 1) anchor LEFT JOIN owned ON true`, [id, actor.clientId, actor.subjectToken])).rows;
      const first = rows[0];
      if (!first || typeof first.accepted !== 'boolean') throw new Error('financial_acceptance_lookup_incomplete');
      if (first.id === null) {
        if (rows.length !== 1) throw new InvalidFinancialRecord();
        return first.accepted ? { status: 'foreign' } : { status: 'absent' };
      }
      const owned = rows.filter((row): row is RecordRow & { accepted: boolean } => row.id !== null);
      const record = owned.length === rows.length ? recordFrom(owned) : null;
      if (!record || !first.accepted) throw new InvalidFinancialRecord();
      return { status: 'owned', record };
    });
  }
  importAcceptance(policy: StoredPolicy, event: ImportedEvent, traceId: string, capture: FinancialDecisionCapture): Promise<AcceptanceImport> {
    return this.connection(async db => {
      const offer = policy.offer;
      const result = await db.query<{ payload_hash: string | null; policy_id: string | null; outcome: string | null; conflict: boolean; imported: string | null }>(`WITH prior AS (
        SELECT payload_hash,policy_id,outcome FROM policy.inbox_events WHERE event_id=$14 AND consumer=$19
      ), rival AS (
        SELECT EXISTS(SELECT 1 FROM policy.financial_contracts WHERE acceptance_id=$5::STRING::UUID
          OR (terms->>'offerId'=$23 AND terms->>'offerVersion'=$24)) AS conflict
      ), created AS (
        INSERT INTO policy.policies(id,subject_token,offer_id,offer_version,idempotency_key,request_hash,status,premium,currency,coverage_snapshot,effective_from,effective_until,correlation_id)
        SELECT $1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10,$11,$12
        WHERE NOT EXISTS(SELECT 1 FROM prior) AND NOT (SELECT conflict FROM rival) RETURNING id
      ), contracted AS (
        INSERT INTO policy.financial_contracts(policy_id,client_id,acceptance_id,acceptance_event_id,terms,terms_hash,document,document_hash,decision_capture)
        SELECT id,$13,$5::UUID,$14,$15,$6,$16,$17,$18 FROM created RETURNING policy_id
      ), received AS (
        INSERT INTO policy.inbox_events(event_id,consumer,event_type,event_version,outcome,correlation_id,payload_hash,policy_id)
        SELECT $14,$19,$20,1,'accepted',$12,$21,policy_id FROM contracted RETURNING policy_id
      ), audited AS (
        INSERT INTO policy.audit_events(actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
        SELECT $22,'offer.accepted','financial_decision',policy_id,'accepted',$12,now()+interval '90 days' FROM received RETURNING resource_id,correlation_id
      ), evented AS (
        INSERT INTO policy.outbox_events(event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id)
        SELECT gen_random_uuid(),'financial_decision',resource_id,'policy.offer.accepted',1,$18,correlation_id FROM audited RETURNING aggregate_id
      ) SELECT prior.payload_hash,prior.policy_id,prior.outcome,rival.conflict,evented.aggregate_id AS imported
        FROM rival LEFT JOIN prior ON true LEFT JOIN evented ON true`,
      [policy.id, policy.subjectToken, policy.offerId, policy.offerVersion, offer.acceptanceId, policy.termsHash, policy.premium, policy.currency,
        JSON.stringify(offer.coverage), policy.effectiveFrom, policy.effectiveUntil, traceId, policy.clientId, event.eventId, JSON.stringify(offer),
        policy.document, policy.documentHash, JSON.stringify(capture), event.consumer, event.eventType, event.hash, policy.clientId, policy.offerId, String(policy.offerVersion)]);
      const row = result.rows[0];
      if (result.rowCount !== 1 || !row || typeof row.conflict !== 'boolean') throw new InvalidFinancialRecord();
      if (row.imported === policy.id) return { status: 'created' };
      if (row.imported !== null || (row.outcome === null && !row.conflict)) throw new Error('financial_import_incomplete');
      return { status: 'existing', snapshot: { conflict: row.conflict,
        inbox: row.outcome === null ? null : { hash: row.payload_hash, policyId: row.policy_id, outcome: row.outcome } } };
    });
  }
  async rejection(id: string, traceId: string, cause: FinancialErrorCode, capture: FinancialDecisionCapture): Promise<void> {
    await this.transaction(tx => tx.audit('financial.denied', id, traceId, cause, 'unattributed', capture));
  }
}
