import { Client } from 'pg';
import type { AuditDecisionStore, AuditQuery, AuditReader } from '../../application/audit-decisions';
import type { AuditSummary, HistoricalDecision, AuditRevision } from '../../domain/audit-decision';

type Row = { id: string; decided_at: Date; outcome: string; rule_version: string; contract_version: string; correlation_id: string; quote_code: string | null; product: string | null; input_snapshot: unknown };
const product = `CASE WHEN d.input_snapshot->'rule'->>'id' = 'mortgage-underwriting' THEN 'vida_hipotecario' WHEN d.input_snapshot->'rule'->>'id' = 'flight-underwriting' THEN 'flight_delay' ELSE NULL END`;
const projection = `d.id, d.decided_at, d.outcome, d.rule_version, d.contract_version, d.correlation_id, q.quote_code, ${product} AS product`;
const summary = (r: Row): AuditSummary => ({ decisionId: r.id, decidedAt: r.decided_at.toISOString(), outcome: r.outcome, ruleVersion: r.rule_version, contractVersion: r.contract_version, correlationId: r.correlation_id, quoteId: r.quote_code, product: r.product });

export class SqlAuditDecisions implements AuditDecisionStore {
  constructor(private readonly connectionString: string) {}
  async list(query: AuditQuery, reader: AuditReader) {
    return this.read(reader, reader.clientId, 'underwriting_decision_collection', async client => {
      const values: string[] = [];
      const conditions: string[] = [];
      const parameter = (value: string) => { values.push(value); return `$${values.length}`; };
      if (query.reference) {
        const ref = parameter(query.reference);
        conditions.push(query.reference.startsWith('COT-') ? `q.quote_code = ${ref}`
          : `(d.id = ${ref}::UUID OR EXISTS (SELECT 1 FROM acquisition.offer_revisions r WHERE r.decision_id = d.id AND r.offer_id = ${ref}::UUID))`);
      }
      if (query.product) conditions.push(`${product} = ${parameter(query.product)}`);
      if (query.outcome) conditions.push(`d.outcome = ${parameter(query.outcome)}`);
      if (query.from) conditions.push(`d.decided_at >= ${parameter(query.from + 'T00:00:00-05:00')}::TIMESTAMPTZ`);
      if (query.to) conditions.push(`d.decided_at < ${parameter(query.to + 'T00:00:00-05:00')}::TIMESTAMPTZ + INTERVAL '1 day'`);
      if (query.before) conditions.push(`(d.decided_at, d.id) < (SELECT decided_at, id FROM acquisition.underwriting_decisions WHERE id = ${parameter(query.before)}::UUID)`);
      const result = await client.query<Row>(`SELECT ${projection} FROM acquisition.underwriting_decisions d LEFT JOIN acquisition.quotes q ON q.id = d.quote_id ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY d.decided_at DESC, d.id DESC LIMIT 21`, values);
      return { items: result.rows.slice(0, 20).map(summary), next: result.rows.length > 20 ? result.rows[19].id : null };
    });
  }
  async get(id: string, reader: AuditReader): Promise<HistoricalDecision | null> {
    return this.read(reader, id, 'underwriting_decision', async client => {
      const result = await client.query<Row>(`SELECT ${projection}, d.input_snapshot FROM acquisition.underwriting_decisions d LEFT JOIN acquisition.quotes q ON q.id = d.quote_id WHERE d.id = $1`, [id]);
      const row = result.rows[0];
      if (!row) return null;
      const revisions = await client.query<{ offer_id: string; version: string; premium: string; currency: string; coverages: unknown; valid_from: Date; expires_at: Date }>(
        'SELECT offer_id, version, premium::STRING, currency, coverages, valid_from, expires_at FROM acquisition.offer_revisions WHERE decision_id = $1 ORDER BY offer_id, version LIMIT 101', [id]);
      if (revisions.rows.length > 100) throw new Error('audit_revision_limit');
      const mapped: AuditRevision[] = revisions.rows.map(r => ({ offerId: r.offer_id, version: Number(r.version), premium: r.premium, currency: r.currency, coverage: r.coverages, validFrom: r.valid_from.toISOString(), expiresAt: r.expires_at.toISOString() }));
      return { ...summary(row), snapshot: row.input_snapshot, revisions: mapped };
    });
  }
  private async read<T>(reader: AuditReader, resourceId: string, resourceType: string, lookup: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1500, query_timeout: 1500 });
    client.on('error', () => {});
    try {
      await client.connect();
      await client.query('BEGIN');
      const result = await lookup(client);
      const audit = await client.query(`INSERT INTO acquisition.audit_events (actor_reference, action, resource_type, resource_id, outcome, correlation_id, retention_until)
        SELECT $1, 'underwriting.audit.read', $2, $3, $4, $5, now() + INTERVAL '5 years' WHERE clock_timestamp() < $6::TIMESTAMPTZ RETURNING id`,
      [reader.clientId, resourceType, resourceId, result === null ? 'not_found' : 'success', reader.traceId, reader.expiresAt]);
      if (audit.rowCount !== 1) throw new Error('audit_authorization_expired');
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { await client.end().catch(() => {}); }
  }
}
