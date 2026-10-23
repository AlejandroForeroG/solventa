import { Client } from 'pg';
import type { AcceptedOffer, OfferStore, StoredOffer, StoredOfferRequest } from '../../application/ports/offer-store';
import { offerRequestIdentity, type OfferActor, type OfferQuote } from '../../domain/offer';

type OfferRow = { terms: StoredOffer['terms']; terms_seal: string; consent_reference: string; consent_version: string };
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
  async quote(actor: OfferActor, quoteId: string): Promise<OfferQuote | null> {
    return this.connection(async c => {
      const r = await c.query<{ id: string; quote_code: string; result: { sumInsured: number; termMonths: number; validUntil: string }; normalized_request: { inputs: { ageYears: number } } }>(
        "SELECT id, quote_code, result, normalized_request FROM acquisition.quotes WHERE quote_code=$1 AND client_id=$2 AND subject_token=$3 AND status='completed'", [quoteId, actor.clientId, actor.subjectToken]);
      const q = r.rows[0];
      return q ? { id: q.id, quoteId: q.quote_code, amount: q.result.sumInsured, termMonths: q.result.termMonths, validUntil: q.result.validUntil, ageYears: q.normalized_request.inputs.ageYears } : null;
    });
  }
  async request(actor: OfferActor, key: string): Promise<StoredOfferRequest | null> {
    return this.connection(async c => {
      const result = await c.query<OfferRow & { client_id: string; subject_token: string; request_identity: string; outcome: 'accepted' | 'declined' }>(`SELECT r.client_id,r.subject_token,r.request_identity,r.outcome,ctx.terms,ctx.terms_seal,ctx.consent_reference,ctx.consent_version
        FROM acquisition.offer_requests r LEFT JOIN acquisition.offer_contexts ctx ON ctx.offer_id=r.offer_id
        WHERE r.client_id=$1 AND r.subject_token=$2 AND r.idempotency_key=$3`, [actor.clientId, actor.subjectToken, key]);
      const row = result.rows[0]; if (!row) return null;
      const common = { actor: { clientId: row.client_id, subjectToken: row.subject_token }, requestIdentity: row.request_identity };
      if (row.outcome === 'declined') return { ...common, outcome: 'declined' };
      if (!row.terms) throw new Error('offer_request_context_missing');
      return { ...common, outcome: 'accepted', offer: fromRow(row) };
    });
  }
  private async winner(actor: OfferActor, key: string): Promise<StoredOfferRequest | null> {
    const request = await this.request(actor, key); if (request) return request;
    const offer = await this.byKey(actor, key); if (!offer) return null;
    const source = offer.terms.coverage.kind === 'flight_delay' ? offer.terms.coverage.flightReference : offer.terms.quoteId;
    if (!source) throw new Error('offer_request_source_missing');
    return { actor, requestIdentity: offerRequestIdentity(offer.terms.product, source), outcome: 'accepted', offer };
  }
  async byKey(actor: OfferActor, key: string) {
    return this.connection(async c => {
      const result = await c.query<OfferRow>('SELECT terms, terms_seal, consent_reference, consent_version FROM acquisition.offer_contexts WHERE client_id=$1 AND subject_token=$2 AND idempotency_key=$3', [actor.clientId, actor.subjectToken, key]);
      return result.rows[0] ? fromRow(result.rows[0]) : null;
    });
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
      await c.query('BEGIN');
      try {
        const decision = await c.query<{ id: string }>(`INSERT INTO acquisition.underwriting_decisions (quote_id,rule_version,contract_version,outcome,explanation,input_snapshot,correlation_id)
          VALUES ($1,$2,'v1',$3,$4,$4,$5) RETURNING id`, [input.quote?.id ?? null, t.ruleVersion, t.status === 'preliminary' ? 'preliminary' : 'accepted', JSON.stringify(input.capture), input.traceId]);
        await c.query(`INSERT INTO acquisition.offers (id,version,decision_id,premium,currency,coverages,status,valid_from,expires_at)
          VALUES ($1,1,$2,$3,'COP',$4,$5,$6,$7)`, [t.offerId, decision.rows[0].id, t.premium, JSON.stringify(t.coverage), t.status, t.effectiveFrom, t.expiresAt]);
        await c.query(`INSERT INTO acquisition.offer_revisions (offer_id,version,decision_id,premium,currency,coverages,valid_from,expires_at)
          VALUES ($1,1,$2,$3,'COP',$4,$5,$6)`, [t.offerId, decision.rows[0].id, t.premium, JSON.stringify(t.coverage), t.effectiveFrom, t.expiresAt]);
        await c.query(`INSERT INTO acquisition.offer_contexts (offer_id,quote_id,client_id,subject_token,idempotency_key,source_reference,terms,terms_seal,consent_reference,consent_version)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [t.offerId, input.quote?.id ?? null, input.actor.clientId, input.actor.subjectToken, input.key, input.sourceReference, JSON.stringify(t), input.offer.seal, input.offer.consentId, input.offer.consentVersion]);
        await this.audit(c, input.actor.clientId, 'offer.create', t.offerId, 'success', input.traceId);
        await c.query(`INSERT INTO acquisition.outbox_events (event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id)
          VALUES (gen_random_uuid(),'offer',$1,'offer.created',1,$2,$3)`, [t.offerId, JSON.stringify({ offerId: t.offerId, status: t.status, synthetic: true }), input.traceId]);
        await c.query(`INSERT INTO acquisition.offer_requests (client_id,subject_token,idempotency_key,request_identity,outcome,decision_id,offer_id)
          VALUES ($1,$2,$3,$4,'accepted',$5,$6)`, [input.actor.clientId, input.actor.subjectToken, input.key, input.requestIdentity, decision.rows[0].id, t.offerId]);
        await c.query('COMMIT');
        return { created: true, request: { actor: input.actor, requestIdentity: input.requestIdentity, outcome: 'accepted' as const, offer: input.offer } };
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        if ((e as { code?: string }).code === '23505') {
          const winner = await this.winner(input.actor, input.key);
          if (winner) return { created: false, request: winner };
        }
        throw e;
      }
    }));
  }
  async acceptance(actor: OfferActor, key: string) {
    return this.connection(async c => {
      const r = await c.query<{ result: AcceptedOffer }>('SELECT result FROM acquisition.offer_acceptances WHERE client_id=$1 AND subject_token=$2 AND idempotency_key=$3', [actor.clientId, actor.subjectToken, key]);
      return r.rows[0]?.result ?? null;
    });
  }
  async decline(input: Parameters<OfferStore['decline']>[0]) {
    const existing = await this.winner(input.actor, input.key);
    if (existing) return { created: false, request: existing };
    return this.retry(() => this.connection(async c => {
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
          const winner = await this.winner(input.actor, input.key);
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
        const inserted = await c.query<{ id: string }>(`INSERT INTO acquisition.offer_acceptances (id,offer_id,client_id,subject_token,idempotency_key,event_id,accepted_at,result)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`, [input.acceptance.acceptanceId, input.acceptance.offerId, input.actor.clientId, input.actor.subjectToken, input.key, input.event.eventId, input.now, JSON.stringify(input.acceptance)]);
        if (!inserted.rows[0]) {
          const existing = await c.query<{ result: AcceptedOffer }>('SELECT result FROM acquisition.offer_acceptances WHERE client_id=$1 AND subject_token=$2 AND idempotency_key=$3', [input.actor.clientId, input.actor.subjectToken, input.key]);
          await c.query('ROLLBACK');
          const value = existing.rows[0]?.result;
          return value?.offerId === input.acceptance.offerId ? { status: 'replayed' as const, acceptance: value } : { status: 'conflict' as const };
        }
        await this.audit(c, input.actor.clientId, 'offer.accept', input.offer.terms.offerId, 'success', input.traceId);
        await c.query(`INSERT INTO acquisition.outbox_events (event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id)
          VALUES ($1,'offer',$2,'offer.accepted',1,$3,$4)`, [input.event.eventId, input.offer.terms.offerId, JSON.stringify(input.event), input.traceId]);
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
