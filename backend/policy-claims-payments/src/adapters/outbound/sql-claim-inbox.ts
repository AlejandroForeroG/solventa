import { Client } from 'pg';
import { OPEN_CLAIM_STATES, type ClaimState, type OpenClaimRecord } from '../../domain/claims';
import type { ClaimInboxStore, ClaimQuery, ClaimReader, ClaimThresholds } from '../../application/ports/claims';

const PAGE_SIZE = 20;
type Row = { id: string; claim_number: string | null; policy_id: string; status: ClaimState; created_at: Date; estimated_amount: string | null; currency: string;
  assignee_id: string | null; provided: number; required: number; unverified: number };

export class SqlClaimInbox implements ClaimInboxStore {
  constructor(private readonly connectionString: string) {}
  async list(query: ClaimQuery, reader: ClaimReader, thresholds: ClaimThresholds) {
    const client = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1500, query_timeout: 1500 });
    client.on('error', () => {});
    try {
      await client.connect();
      await client.query('BEGIN');
      const values: unknown[] = [[...OPEN_CLAIM_STATES], thresholds.highDays, thresholds.mediumDays];
      const conditions: string[] = [];
      const parameter = (value: unknown) => { values.push(value); return `$${values.length}`; };
      if (query.state) conditions.push(`status = ${parameter(query.state)}`);
      if (query.overdue) conditions.push(`age >= ${parameter(thresholds.overdueDays)}`);
      if (query.query) conditions.push(query.query.startsWith('SIN-') ? `claim_number = ${parameter(query.query)}` : `policy_id = ${parameter(query.query)}::UUID`);
      if (query.before) conditions.push(`(rank, created_at, amount_key, id) > (SELECT rank, created_at, amount_key, id FROM ranked WHERE id = ${parameter(query.before)}::UUID)`);
      // A claim without an estimate sorts after every estimated one, so one ascending key serves the order and the keyset cursor.
      const order = 'rank, created_at, amount_key, id';
      const result = await client.query<Row>(`WITH open AS (
          SELECT id, claim_number, policy_id, status, created_at, estimated_amount, currency, assignee_id, evidence_required,
            COALESCE(-estimated_amount, 10000000000000000::DECIMAL) AS amount_key,
            (((now() AT TIME ZONE 'America/Bogota')::DATE) - ((created_at AT TIME ZONE 'America/Bogota')::DATE))::INT4 AS age
          FROM policy.claims WHERE status = ANY($1::STRING[])
        ), ranked AS (
          SELECT *, CASE WHEN status = 'escalated' OR age >= $2 THEN 1 WHEN age >= $3 THEN 2 ELSE 3 END AS rank FROM open
        ), page AS (
          SELECT * FROM ranked ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY ${order} LIMIT ${PAGE_SIZE + 1}
        ) SELECT p.id, p.claim_number, p.policy_id, p.status, p.created_at, p.estimated_amount::STRING AS estimated_amount, p.currency, p.assignee_id,
          p.evidence_required::INT4 AS required,
          (SELECT count(*) FROM policy.evidence_metadata e WHERE e.claim_id = p.id AND e.state IN ('uploaded', 'verified'))::INT4 AS provided,
          (SELECT count(*) FROM policy.evidence_metadata e WHERE e.claim_id = p.id AND e.state = 'uploaded')::INT4 AS unverified
        FROM page p ORDER BY ${order.replaceAll(/\b(rank|created_at|amount_key|id)\b/g, 'p.$1')}`, values);
      const audit = await client.query(`INSERT INTO policy.audit_events (actor_reference, action, resource_type, resource_id, outcome, correlation_id, retention_until)
        SELECT $1, 'claims.inbox.read', 'claim_collection', $2::UUID, 'success', $3, now() + INTERVAL '90 days' WHERE clock_timestamp() < $4::TIMESTAMPTZ RETURNING id`,
      [reader.clientId, reader.clientId, reader.traceId, reader.expiresAt]);
      if (audit.rowCount !== 1) throw new Error('claims_authorization_expired');
      await client.query('COMMIT');
      const records: OpenClaimRecord[] = result.rows.slice(0, PAGE_SIZE).map(row => ({ id: row.id, claimNumber: row.claim_number as string, policyId: row.policy_id,
        state: row.status, openedAt: row.created_at, estimatedAmount: row.estimated_amount, currency: row.currency, assigneeId: row.assignee_id,
        provided: row.provided, required: row.required, unverified: row.unverified }));
      return { records, next: result.rows.length > PAGE_SIZE ? result.rows[PAGE_SIZE - 1].id : null };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { await client.end().catch(() => {}); }
  }
}
