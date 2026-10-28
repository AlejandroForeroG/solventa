import { Client } from 'pg';
import type { NewQuote, QuoteStore, SaveResult, StoredQuote } from '../../application/ports/quote-store';

const RETENTION = '5 years'; // Provisional audit retention until the policy owner defines it.
const SERIALIZATION_FAILURE = '40001';

type Row = { quote_code: string; request_hash: string; result: Omit<StoredQuote, 'quoteId'> & { currency: string; basis: string } };
const fromRow = (row: Row): StoredQuote => ({ quoteId: row.quote_code, premiumMonthly: row.result.premiumMonthly, sumInsured: row.result.sumInsured, termMonths: row.result.termMonths, validUntil: row.result.validUntil, ruleVersion: row.result.ruleVersion });

function ownerOf(q: NewQuote) {
  return q.actor.kind === 'partner'
    ? { column: 'partner_id', actorId: q.actor.partnerId, partnerId: q.actor.partnerId, clientId: null }
    : { column: 'client_id', actorId: q.actor.clientId, partnerId: null, clientId: q.actor.clientId };
}

export class SqlQuoteStore implements QuoteStore {
  constructor(private readonly connectionString: string, private readonly devTiming = false) {}

  async save(quote: NewQuote): Promise<SaveResult> {
    for (let attempt = 1; ; attempt++) {
      try { return await this.once(quote); }
      catch (error) {
        if ((error as { code?: string }).code !== SERIALIZATION_FAILURE || attempt >= 3) throw error;
      }
    }
  }

  private async once(q: NewQuote): Promise<SaveResult> {
    const started = performance.now();
    const stages: Record<string, number> = {};
    let outcome = 'failed';
    const timed = async <T>(stage: string, action: () => Promise<T>): Promise<T> => {
      const begin = performance.now();
      try { return await action(); }
      finally { stages[stage] = Math.round((performance.now() - begin) * 10) / 10; }
    };
    const client = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 3000, query_timeout: 3000 });
    client.on('error', () => {});
    try {
      await timed('connect', () => client.connect());
      const owner = ownerOf(q);
      const storedFields = { premiumMonthly: q.premiumMonthly, sumInsured: q.amount, termMonths: q.termMonths,
        validUntil: q.validUntil, ruleVersion: q.ruleVersion, currency: 'COP', basis: 'minimum_data' };
      // One implicit transaction releases the counter with the business commit, without a network
      // round trip while its row is locked. Existing keys allocate no code and write no effects.
      const saved = await timed('save', () => client.query<Row & { created: boolean }>(
        `WITH existing AS (
           SELECT quote_code, request_hash, result FROM acquisition.quotes
           WHERE ${owner.column} = $12 AND idempotency_key = $3
         ), allocated AS (
           INSERT INTO acquisition.quote_counters (year, last_value)
           SELECT $13::INT8, 1 WHERE NOT EXISTS (SELECT 1 FROM existing)
           ON CONFLICT (year) DO UPDATE SET last_value = acquisition.quote_counters.last_value + 1
           RETURNING last_value
         ), numbered AS (
           SELECT 'COT-' || $13::INT8::STRING || '-' || lpad(last_value::STRING, 5, '0') AS quote_code FROM allocated
         ), inserted AS (
           INSERT INTO acquisition.quotes (subject_token, partner_id, idempotency_key, request_hash, normalized_request, rule_version, result, status, correlation_id, quote_code, client_id)
           SELECT $1, $2, $3, $4, $5, $6, $7::JSONB || jsonb_build_object('quoteId', numbered.quote_code), 'completed', $8, numbered.quote_code, $9 FROM numbered
           ON CONFLICT DO NOTHING RETURNING id, quote_code, request_hash, result
         ), audit AS (
           INSERT INTO acquisition.audit_events (actor_reference, action, resource_type, resource_id, outcome, correlation_id, retention_until)
           SELECT $10, 'quote.create', 'quote', inserted.id, 'success', $8, now() + interval '${RETENTION}' FROM inserted
           RETURNING id
         ), outbox AS (
           INSERT INTO acquisition.outbox_events (event_id, aggregate_type, aggregate_id, event_type, event_version, payload, correlation_id)
           SELECT gen_random_uuid(), 'quote', inserted.id, 'quote.created', 1, $11::JSONB || jsonb_build_object('quoteId', inserted.quote_code), $8 FROM inserted
           RETURNING event_id
         )
         SELECT inserted.quote_code, inserted.request_hash, inserted.result, true AS created FROM inserted JOIN audit ON true JOIN outbox ON true
         UNION ALL
         SELECT quote_code, request_hash, result, false AS created FROM existing`,
        [q.subjectToken, owner.partnerId, q.idempotencyKey, q.requestFingerprint,
          JSON.stringify(q.capture), q.ruleVersion,
          JSON.stringify(storedFields), q.traceId, owner.clientId,
          owner.actorId, JSON.stringify({ premiumMonthly: q.premiumMonthly, currency: 'COP', ruleVersion: q.ruleVersion }), owner.actorId, q.year]));
      const row = saved.rows[0];
      if (!row) {
        // A concurrent retry won the unique-key race; read it in a new snapshot.
        const winner = await timed('raceLookup', () => this.find(client, q));
        if (winner) { outcome = winner.kind; return winner; }
        throw Object.assign(new Error('quote_race_unresolved'), { code: SERIALIZATION_FAILURE });
      }
      if (!row.created && row.request_hash !== q.requestFingerprint) { outcome = 'conflict'; return { kind: 'conflict' }; }
      outcome = row.created ? 'created' : 'replayed';
      return { kind: row.created ? 'created' : 'replayed', quote: fromRow(row) };
    } finally {
      await timed('close', () => client.end().catch(() => {}));
      const totalMs = Math.round((performance.now() - started) * 10) / 10;
      if (this.devTiming && totalMs >= 250) console.log(JSON.stringify({ event: 'quote_sql_slow', traceId: q.traceId, outcome, totalMs, stages }));
    }
  }

  private async find(client: Client, q: NewQuote): Promise<SaveResult | null> {
    const owner = ownerOf(q);
    const existing = await client.query<Row>(
      `SELECT quote_code, request_hash, result FROM acquisition.quotes WHERE ${owner.column} = $1 AND idempotency_key = $2`,
      [owner.actorId, q.idempotencyKey]);
    const row = existing.rows[0];
    if (!row) return null;
    return row.request_hash === q.requestFingerprint ? { kind: 'replayed', quote: fromRow(row) } : { kind: 'conflict' };
  }
}
