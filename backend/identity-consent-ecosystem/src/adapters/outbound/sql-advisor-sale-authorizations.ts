import { Client } from 'pg';
import type { Principal } from '../../application/authentication';
import type { AdvisorSaleAuthorizationStore, RevokeAdvisorSaleResult } from '../../application/ports/advisor-sale-authorizations';
import { ADVISOR_SALE_OPERATION, type AdvisorSaleAuthorization } from '../../domain/advisor-sale-authorization';

const RETENTION = '5 years'; // Same provisional audit retention as consents.
type Row = { id: string; advisor_reference: string; granted_at: Date; expires_at: Date; revoked_at: Date | null };
const fromRow = (row: Row): AdvisorSaleAuthorization => ({ id: row.id, advisorReference: row.advisor_reference, operation: ADVISOR_SALE_OPERATION,
  grantedAt: row.granted_at, expiresAt: row.expires_at, revokedAt: row.revoked_at });
const SELECT = `SELECT a.id, a.advisor_grant_id AS advisor_reference, a.granted_at, a.expires_at, a.revoked_at
  FROM identity.advisor_sale_authorizations a`;

export class SqlAdvisorSaleAuthorizations implements AdvisorSaleAuthorizationStore {
  constructor(private readonly connectionString: string) {}

  private async connection<T>(action: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 3000, query_timeout: 3000 });
    client.on('error', () => {});
    try { await client.connect(); return await action(client); }
    finally { await client.end().catch(() => {}); }
  }

  private async transaction<T>(client: Client, action: () => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    try { const result = await action(); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  }

  private async record(client: Client, principal: Principal, action: string, authorizationId: string, traceId: string) {
    await client.query(`INSERT INTO identity.audit_events (actor_reference, action, resource_type, resource_id, outcome, correlation_id, retention_until)
      VALUES ($1, $2, 'advisor_sale_authorization', $3, 'success', $4, now() + interval '${RETENTION}')`, [principal.subjectToken, action, authorizationId, traceId]);
    await client.query(`INSERT INTO identity.outbox_events (event_id, aggregate_type, aggregate_id, event_type, event_version, payload, correlation_id)
      VALUES (gen_random_uuid(), 'advisor_sale_authorization', $1, $2, 1, $3, $4)`, [authorizationId, action, JSON.stringify({ authorizationId }), traceId]);
  }

  grant(input: Parameters<AdvisorSaleAuthorizationStore['grant']>[0]) {
    return this.connection(client => this.transaction(client, async () => {
      // The advisor must hold a current professional grant and cannot be the customer who authorizes.
      const advisor = await client.query<{ id: string }>(`SELECT id FROM identity.policy_advisor_grants
        WHERE id = $1 AND client_id <> $2 AND revoked_at IS NULL AND granted_at <= clock_timestamp() AND expires_at > clock_timestamp()`,
      [input.advisorReference, input.principal.clientId]);
      if (!advisor.rows[0]) return null;
      const inserted = await client.query<Row>(`INSERT INTO identity.advisor_sale_authorizations (advisor_grant_id, client_id, operation, granted_at, expires_at)
        VALUES ($1, $2, $3, $4, $5) RETURNING id, advisor_grant_id AS advisor_reference, granted_at, expires_at, revoked_at`,
      [input.advisorReference, input.principal.clientId, ADVISOR_SALE_OPERATION, input.grantedAt, input.expiresAt]);
      await this.record(client, input.principal, 'advisor_sale_authorization.granted', inserted.rows[0].id, input.traceId);
      return fromRow(inserted.rows[0]);
    }));
  }

  list(principal: Principal, limit: number) {
    return this.connection(async client => (await client.query<Row>(`${SELECT} WHERE a.client_id = $1 ORDER BY a.granted_at DESC, a.id LIMIT $2`,
      [principal.clientId, limit])).rows.map(fromRow));
  }

  revoke(principal: Principal, authorizationId: string, now: Date, traceId: string): Promise<RevokeAdvisorSaleResult> {
    return this.connection(client => this.transaction(client, async () => {
      const found = await client.query<Row>(`${SELECT} WHERE a.id = $1 AND a.client_id = $2 FOR UPDATE OF a`, [authorizationId, principal.clientId]);
      const row = found.rows[0];
      if (!row) return { kind: 'not_found' as const };
      if (row.revoked_at) return { kind: 'already_revoked' as const, authorization: fromRow(row) };
      if (row.expires_at.getTime() <= now.getTime()) return { kind: 'expired' as const, authorization: fromRow(row) };
      const updated = await client.query<{ revoked_at: Date }>('UPDATE identity.advisor_sale_authorizations SET revoked_at = clock_timestamp() WHERE id = $1 RETURNING revoked_at', [authorizationId]);
      await this.record(client, principal, 'advisor_sale_authorization.revoked', authorizationId, traceId);
      return { kind: 'revoked' as const, authorization: fromRow({ ...row, revoked_at: updated.rows[0].revoked_at }) };
    }));
  }

  find(advisorReference: string, authorizationId: string) {
    return this.connection(async client => {
      const result = await client.query<{ client_id: string; subject_token: string; expires_at: Date }>(
        `SELECT a.client_id, c.subject_token, a.expires_at
         FROM identity.advisor_sale_authorizations a
         JOIN identity.clients c ON c.id = a.client_id
         WHERE a.id = $1 AND a.advisor_grant_id = $2 AND a.operation = $3 AND a.revoked_at IS NULL
           AND a.granted_at <= clock_timestamp() AND a.expires_at > clock_timestamp()
           AND c.status = 'active'`, [authorizationId, advisorReference, ADVISOR_SALE_OPERATION]);
      const row = result.rows[0];
      return row ? { clientId: row.client_id, subjectToken: row.subject_token, expiresAt: row.expires_at.toISOString() } : null;
    });
  }
}
