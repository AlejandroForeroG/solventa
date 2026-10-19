import { Client } from 'pg';
import type { AcceptedOffer, OfferAcceptanceSnapshot, OfferCreationSnapshot, OfferStore, StoredOffer, StoredOfferRequest } from '../../application/ports/offer-store';
import { offerRequestIdentity, type OfferActor, type OfferQuote } from '../../domain/offer';

type OfferRow = { terms: StoredOffer['terms']; terms_seal: string; consent_reference: string; consent_version: string };
type QuoteSnapshot = { id: string; quoteCode: string; result: { sumInsured: number; termMonths: number; validUntil: string }; request: { inputs: { ageYears: number } } };
type SnapshotRow =
  | (Omit<OfferRow, 'terms'> & { kind: 'request'; terms: OfferRow['terms'] | null; client_id: string; subject_token: string; request_identity: string; outcome: 'accepted' | 'declined' })
  | (OfferRow & { kind: 'legacy' })
  | { kind: 'quote'; quote: QuoteSnapshot };
const fromRow = (r: OfferRow): StoredOffer => ({ terms: r.terms, seal: r.terms_seal, consentId: r.consent_reference, consentVersion: Number(r.consent_version) });
const SERIALIZATION_FAILURE = '40001';
export class SqlOfferStore implements OfferStore {
  constructor(private readonly connectionString: string) {}
  private async connection<T>(action: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 3000, query_timeout: 3000 });
    client.on('error', () => {});
    try { await client.connect(); return await action(client); } finally { await client.end().catch(() => {}); }
  }
  private async retry<T>(action: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await action(); } catch (e) { if ((e as { code?: string }).code !== SERIALIZATION_FAILURE || attempt >= 2) throw e; }
    }
  }
  private async snapshot(c: Client, actor: OfferActor, key: string, quoteId: string | null): Promise<OfferCreationSnapshot> {
    const result = await c.query<SnapshotRow>(`SELECT 'request' AS kind, r.client_id::STRING AS client_id, r.subject_token, r.request_identity, r.outcome,
          ctx.terms, ctx.terms_seal, ctx.consent_reference, ctx.consent_version, NULL::JSONB AS quote
        FROM acquisition.offer_requests r LEFT JOIN acquisition.offer_contexts ctx ON ctx.offer_id=r.offer_id
        WHERE r.client_id=$1::UUID AND r.subject_token=$2::STRING AND r.idempotency_key=$3::STRING
      UNION ALL
      SELECT 'legacy', NULL::STRING, NULL::STRING, NULL::STRING, NULL::STRING, ctx.terms, ctx.terms_seal, ctx.consent_reference, ctx.consent_version, NULL::JSONB
        FROM acquisition.offer_contexts ctx
        WHERE ctx.client_id=$1::UUID AND ctx.subject_token=$2::STRING AND ctx.idempotency_key=$3::STRING
      UNION ALL
      SELECT 'quote', NULL::STRING, NULL::STRING, NULL::STRING, NULL::STRING, NULL::JSONB, NULL::STRING, NULL::STRING, NULL::INT8,
          jsonb_build_object('id', q.id, 'quoteCode', q.quote_code, 'result', q.result, 'request', q.normalized_request)
        FROM acquisition.quotes q
        WHERE $4::STRING IS NOT NULL AND q.quote_code=$4::STRING AND q.client_id=$1::UUID AND q.subject_token=$2::STRING AND q.status='completed'
          AND NOT EXISTS(SELECT 1 FROM acquisition.offer_requests existing WHERE existing.client_id=$1::UUID AND existing.subject_token=$2::STRING AND existing.idempotency_key=$3::STRING)
          AND NOT EXISTS(SELECT 1 FROM acquisition.offer_contexts keyed WHERE keyed.client_id=$1::UUID AND keyed.subject_token=$2::STRING AND keyed.idempotency_key=$3::STRING)`,
    [actor.clientId, actor.subjectToken, key, quoteId]);
    let request: StoredOfferRequest | null = null, legacy: StoredOffer | null = null, quote: OfferQuote | null = null;
    for (const row of result.rows) {
      if (row.kind === 'legacy') legacy = fromRow(row);
      else if (row.kind === 'quote') {
        const q = row.quote;
        quote = { id: q.id, quoteId: q.quoteCode, amount: q.result.sumInsured, termMonths: q.result.termMonths, validUntil: q.result.validUntil, ageYears: q.request.inputs.ageYears };
      } else {
        const common = { actor: { clientId: row.client_id, subjectToken: row.subject_token }, requestIdentity: row.request_identity };
        if (row.outcome === 'declined') request = { ...common, outcome: 'declined' };
        else if (!row.terms) throw new Error('offer_request_context_missing');
        else request = { ...common, outcome: 'accepted', offer: fromRow({ ...row, terms: row.terms }) };
      }
    }
    return { request, legacy, quote };
  }
  async creationSnapshot(actor: OfferActor, key: string, quoteId: string | null) {
    return this.connection(c => this.snapshot(c, actor, key, quoteId));
  }
  private async winner(c: Client, actor: OfferActor, key: string): Promise<StoredOfferRequest | null> {
    const { request, legacy: offer } = await this.snapshot(c, actor, key, null);
    if (request) return request;
    if (!offer) return null;
    const source = offer.terms.coverage.kind === 'flight_delay' ? offer.terms.coverage.flightReference : offer.terms.quoteId;
    if (!source) throw new Error('offer_request_source_missing');
    return { actor, requestIdentity: offerRequestIdentity(offer.terms.product, source), outcome: 'accepted', offer };
  }
  async get(actor: OfferActor, offerId: string) {
    return this.connection(async c => {
      const r = await c.query<OfferRow>('SELECT terms, terms_seal, consent_reference, consent_version FROM acquisition.offer_contexts WHERE offer_id=$1 AND client_id=$2 AND subject_token=$3', [offerId, actor.clientId, actor.subjectToken]);
      return r.rows[0] ? fromRow(r.rows[0]) : null;
    });
  }
  async create(input: Parameters<OfferStore['create']>[0]) {
    return this.retry(() => this.connection(async c => {
      const t = input.offer.terms;
      try {
        const created = await c.query(`WITH decision AS (
          INSERT INTO acquisition.underwriting_decisions (quote_id,rule_version,contract_version,outcome,explanation,input_snapshot,correlation_id)
          VALUES ($1,$2,'v1','accepted',$3,$3,$4) RETURNING id
        ), offered AS (
          INSERT INTO acquisition.offers (id,version,decision_id,premium,currency,coverages,status,valid_from,expires_at)
          SELECT $5,1,id,$6,'COP',$7,'definitive',$8,$9 FROM decision RETURNING id,decision_id
        ), revision AS (
          INSERT INTO acquisition.offer_revisions (offer_id,version,decision_id,premium,currency,coverages,valid_from,expires_at)
          SELECT id,1,decision_id,$6,'COP',$7,$8,$9 FROM offered RETURNING offer_id
        ), context AS (
          INSERT INTO acquisition.offer_contexts (offer_id,quote_id,client_id,subject_token,idempotency_key,source_reference,terms,terms_seal,consent_reference,consent_version)
          SELECT id,$1,$10::UUID,$11::UUID,$12,$13,$14,$15,$16,$17 FROM offered RETURNING offer_id
        ), audited AS (
          INSERT INTO acquisition.audit_events (actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
          SELECT $10::STRING,'offer.create','offer',id,'success',$4,now()+interval '5 years' FROM offered RETURNING correlation_id
        ), evented AS (
          INSERT INTO acquisition.outbox_events (event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id)
          SELECT gen_random_uuid(),'offer',id,'offer.created',1,$19,$4 FROM offered RETURNING event_id
        ) INSERT INTO acquisition.offer_requests (client_id,subject_token,idempotency_key,request_identity,outcome,decision_id,offer_id)
          SELECT $10::UUID,$11::UUID,$12,$18,'accepted',decision_id,id FROM offered`,
        [input.quote?.id ?? null, t.ruleVersion, JSON.stringify(input.capture), input.traceId, t.offerId, t.premium, JSON.stringify(t.coverage),
          t.effectiveFrom, t.expiresAt, input.actor.clientId, input.actor.subjectToken, input.key, input.sourceReference,
          JSON.stringify(t), input.offer.seal, input.offer.consentId, input.offer.consentVersion, input.requestIdentity,
          JSON.stringify({ offerId: t.offerId, synthetic: true })]);
        if (created.rowCount !== 1) throw new Error('offer_creation_incomplete');
        return { created: true, request: { actor: input.actor, requestIdentity: input.requestIdentity, outcome: 'accepted' as const, offer: input.offer } };
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          const winner = await this.winner(c, input.actor, input.key);
          if (winner) return { created: false, request: winner };
        }
        throw e;
      }
    }));
  }
  async acceptanceSnapshot(actor: OfferActor, offerId: string, key: string): Promise<OfferAcceptanceSnapshot> {
    return this.connection(async c => {
      const r = await c.query<OfferRow & { acceptance: AcceptedOffer | null }>(`SELECT ctx.terms, ctx.terms_seal, ctx.consent_reference, ctx.consent_version,
          (SELECT a.result FROM acquisition.offer_acceptances a WHERE a.client_id=$2 AND a.subject_token=$3 AND a.idempotency_key=$4) AS acceptance
        FROM acquisition.offer_contexts ctx WHERE ctx.offer_id=$1 AND ctx.client_id=$2 AND ctx.subject_token=$3`, [offerId, actor.clientId, actor.subjectToken, key]);
      const row = r.rows[0];
      return row ? { offer: fromRow(row), acceptance: row.acceptance } : { offer: null, acceptance: null };
    });
  }
  async decline(input: Parameters<OfferStore['decline']>[0]) {
    return this.retry(() => this.connection(async c => {
      const existing = await this.winner(c, input.actor, input.key);
      if (existing) return { created: false, request: existing };
      await c.query('BEGIN');
      try {
        const d = await c.query<{ id: string }>(`INSERT INTO acquisition.underwriting_decisions (quote_id,rule_version,contract_version,outcome,explanation,input_snapshot,correlation_id)
          VALUES ($1,$2,'v1','declined',$3,$3,$4) RETURNING id`, [input.quote.id, input.capture.rule.version, JSON.stringify(input.capture), input.traceId]);
        await this.audit(c, input.actor.clientId, 'underwriting.decline', d.rows[0].id, 'declined', input.traceId, 'underwriting');
        await c.query(`INSERT INTO acquisition.outbox_events (event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id)
          VALUES (gen_random_uuid(),'underwriting',$1,'underwriting.declined',1,$2,$3)`, [d.rows[0].id, JSON.stringify({ decisionId: d.rows[0].id, synthetic: true }), input.traceId]);
        await c.query(`INSERT INTO acquisition.offer_requests (client_id,subject_token,idempotency_key,request_identity,outcome,decision_id,offer_id)
          VALUES ($1,$2,$3,$4,'declined',$5,NULL)`, [input.actor.clientId, input.actor.subjectToken, input.key, input.requestIdentity, d.rows[0].id]);
        await c.query('COMMIT');
        return { created: true, request: { actor: input.actor, requestIdentity: input.requestIdentity, outcome: 'declined' as const } };
      } catch (error) {
        await c.query('ROLLBACK').catch(() => {});
        if ((error as { code?: string }).code === '23505') {
          const winner = await this.winner(c, input.actor, input.key);
          if (winner) return { created: false, request: winner };
        }
        throw error;
      }
    }));
  }
  async accept(input: Parameters<OfferStore['accept']>[0]): ReturnType<OfferStore['accept']> {
    return this.retry(() => this.connection(async c => {
      await c.query('BEGIN');
      try {
        const offer = await c.query<{ terms_seal: string; status: string; expired: boolean }>(`SELECT context.terms_seal, o.status, (o.expires_at<=now() OR $4::TIMESTAMPTZ<=now()) AS expired FROM acquisition.offer_contexts context
          JOIN acquisition.offers o ON o.id=context.offer_id WHERE context.offer_id=$1 AND context.client_id=$2 AND context.subject_token=$3 FOR UPDATE OF o`, [input.offer.terms.offerId, input.actor.clientId, input.actor.subjectToken, input.authorizedUntil]);
        const current = offer.rows[0];
        if (!current || current.status !== 'definitive' || current.terms_seal !== input.offer.seal) { await c.query('ROLLBACK'); return { status: 'conflict' as const }; }
        if (current.expired) { await c.query('ROLLBACK'); return { status: 'expired' as const }; }
        // now() is fixed at transaction start, so it cannot see time spent waiting for the row lock.
        // Recheck the current offer, its sealed terms and the authorization with the wall clock before writing.
        const late = await c.query<{ expired: boolean }>(`SELECT clock_timestamp() >= least(o.expires_at, $2::TIMESTAMPTZ, $3::TIMESTAMPTZ) AS expired
          FROM acquisition.offers o WHERE o.id=$1`, [input.offer.terms.offerId, input.offer.terms.expiresAt, input.authorizedUntil]);
        if (late.rows[0]?.expired !== false) { await c.query('ROLLBACK'); return { status: 'expired' as const }; }
        // Audit and outbox select from the inserted acceptance, so an ON CONFLICT no-op cannot produce either.
        const written = await c.query<{ acceptances: number; audits: number; events: number }>(`WITH accepted AS (
          INSERT INTO acquisition.offer_acceptances (id,offer_id,client_id,subject_token,idempotency_key,event_id,accepted_at,result)
          VALUES ($1,$2,$3::UUID,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id
        ), audited AS (
          INSERT INTO acquisition.audit_events (actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
          SELECT $3::STRING,'offer.accept','offer',$11,'success',$9,now()+interval '5 years' FROM accepted RETURNING correlation_id
        ), evented AS (
          INSERT INTO acquisition.outbox_events (event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id)
          SELECT $6,'offer',$11,'offer.accepted',1,$10,correlation_id FROM audited RETURNING event_id
        ) SELECT (SELECT count(*) FROM accepted)::INT4 AS acceptances, (SELECT count(*) FROM audited)::INT4 AS audits, (SELECT count(*) FROM evented)::INT4 AS events`,
        [input.acceptance.acceptanceId, input.acceptance.offerId, input.actor.clientId, input.actor.subjectToken, input.key, input.event.eventId, input.now,
          JSON.stringify(input.acceptance), input.traceId, JSON.stringify(input.event), input.offer.terms.offerId]);
        const effects = written.rows[0];
        if (effects?.acceptances === 0 && effects.audits === 0 && effects.events === 0) {
          const existing = await c.query<{ result: AcceptedOffer }>('SELECT result FROM acquisition.offer_acceptances WHERE client_id=$1 AND subject_token=$2 AND idempotency_key=$3', [input.actor.clientId, input.actor.subjectToken, input.key]);
          await c.query('ROLLBACK');
          const value = existing.rows[0]?.result;
          return value?.offerId === input.acceptance.offerId ? { status: 'replayed' as const, acceptance: value } : { status: 'conflict' as const };
        }
        if (effects?.acceptances !== 1 || effects.audits !== 1 || effects.events !== 1) throw new Error('offer_acceptance_evidence_incomplete');
        await c.query('COMMIT');
        return { status: 'created' as const, acceptance: input.acceptance };
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    }));
  }
  private audit(c: Client, actor: string, action: string, id: string, outcome: string, trace: string, resourceType = 'offer') {
    return c.query(`INSERT INTO acquisition.audit_events (actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
      VALUES ($1,$2,$6,$3,$4,$5,now()+interval '5 years')`, [actor, action, id, outcome, trace, resourceType]);
  }
  async reject(actor: OfferActor, offerId: string, traceId: string, reason: 'expired' | 'integrity_invalid', operation: 'offer.read' | 'offer.accept' = 'offer.accept') {
    await this.connection(c => this.audit(c, actor.clientId, operation, offerId, reason, traceId));
  }
}
