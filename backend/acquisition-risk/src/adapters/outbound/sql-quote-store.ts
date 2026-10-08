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
  constructor(private readonly connectionString: string) {}

  async save(quote: NewQuote): Promise<SaveResult> {
    for (let attempt = 1; ; attempt++) {
      try { return await this.once(quote); }
      catch (error) {
        if ((error as { code?: string }).code !== SERIALIZATION_FAILURE || attempt >= 3) throw error;
      }
    }
  }

  private async once(q: NewQuote): Promise<SaveResult> {
    const client = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 3000, query_timeout: 3000 });
    client.on('error', () => {});
    await client.connect();
    try {
      const found = await this.find(client, q);
      if (found) return found;

      // Allocated before the transaction: inside it the counter row stays locked until COMMIT and
      // serializes every quote. A failed transaction leaves a gap in the numbering, never a repeat.
      const year = q.year;
      const counter = await client.query<{ last_value: string }>(
        'INSERT INTO acquisition.quote_counters (year, last_value) VALUES ($1, 1) ON CONFLICT (year) DO UPDATE SET last_value = acquisition.quote_counters.last_value + 1 RETURNING last_value', [year]);
      const code = `COT-${year}-${String(counter.rows[0].last_value).padStart(5, '0')}`;
      await client.query('BEGIN');
      const owner = ownerOf(q);
      const stored: StoredQuote = { quoteId: code, premiumMonthly: q.premiumMonthly, sumInsured: q.amount, termMonths: q.termMonths, validUntil: q.validUntil, ruleVersion: q.ruleVersion };
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO acquisition.quotes (subject_token, partner_id, idempotency_key, request_hash, normalized_request, rule_version, result, status, correlation_id, quote_code, client_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', $8, $9, $10)
         ON CONFLICT DO NOTHING RETURNING id`,
        [q.subjectToken, owner.partnerId, q.idempotencyKey, q.requestFingerprint,
          JSON.stringify(q.capture), q.ruleVersion,
          JSON.stringify({ ...stored, currency: 'COP', basis: 'minimum_data' }), q.traceId, code, owner.clientId]);
      if (!inserted.rows[0]) {
        // A concurrent retry won the race: discard our work and answer from its row.
        await client.query('ROLLBACK');
        const winner = await this.find(client, q);
        if (winner) return winner;
        throw Object.assign(new Error('quote_race_unresolved'), { code: SERIALIZATION_FAILURE });
      }
      const id = inserted.rows[0].id;
      await client.query(
        `INSERT INTO acquisition.audit_events (actor_reference, action, resource_type, resource_id, outcome, correlation_id, retention_until)
         VALUES ($1, 'quote.create', 'quote', $2, 'success', $3, now() + interval '${RETENTION}')`, [owner.actorId, id, q.traceId]);
      await client.query(
        `INSERT INTO acquisition.outbox_events (event_id, aggregate_type, aggregate_id, event_type, event_version, payload, correlation_id)
         VALUES (gen_random_uuid(), 'quote', $1, 'quote.created', 1, $2, $3)`,
        [id, JSON.stringify({ quoteId: code, premiumMonthly: q.premiumMonthly, currency: 'COP', ruleVersion: q.ruleVersion }), q.traceId]);
      await client.query('COMMIT');
      return { kind: 'created', quote: stored };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await client.end().catch(() => {});
    }
  }

  private async find(client: Client, q: NewQuote): Promise<SaveResult | null> {
    const owner = ownerOf(q);
    const existing = await client.query<Row>(
      `SELECT quote_code, request_hash, result FROM acquisition.quotes WHERE ${owner.column} = $1 AND subject_token = $2 AND idempotency_key = $3`,
      [owner.actorId, q.subjectToken, q.idempotencyKey]);
    const row = existing.rows[0];
    if (!row) return null;
    return row.request_hash === q.requestFingerprint ? { kind: 'replayed', quote: fromRow(row) } : { kind: 'conflict' };
  }
}
