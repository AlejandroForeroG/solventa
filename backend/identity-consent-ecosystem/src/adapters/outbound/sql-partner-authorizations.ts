import { Client } from 'pg';
import type { Principal } from '../../application/authentication';
import type { PartnerAuthorizationStore, RevokeAuthorizationResult } from '../../application/ports/partner-authorizations';
import { PARTNER_OFFER_OPERATION, type PartnerAuthorization } from '../../domain/partner-authorization';

const RETENTION = '5 years'; // Same provisional audit retention as consents.
type Row = { id: string; partner_code: string; granted_at: Date; expires_at: Date; revoked_at: Date | null };
const fromRow = (row: Row): PartnerAuthorization => ({ id: row.id, partnerCode: row.partner_code, operation: PARTNER_OFFER_OPERATION,
  grantedAt: row.granted_at, expiresAt: row.expires_at, revokedAt: row.revoked_at });
const SELECT = `SELECT a.id, p.code AS partner_code, a.granted_at, a.expires_at, a.revoked_at
  FROM identity.partner_authorizations a JOIN identity.partners p ON p.id = a.partner_id`;

export class SqlPartnerAuthorizations implements PartnerAuthorizationStore {
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
      VALUES ($1, $2, 'partner_authorization', $3, 'success', $4, now() + interval '${RETENTION}')`, [principal.subjectToken, action, authorizationId, traceId]);
    await client.query(`INSERT INTO identity.outbox_events (event_id, aggregate_type, aggregate_id, event_type, event_version, payload, correlation_id)
      VALUES (gen_random_uuid(), 'partner_authorization', $1, $2, 1, $3, $4)`, [authorizationId, action, JSON.stringify({ authorizationId }), traceId]);
  }

  grant(input: Parameters<PartnerAuthorizationStore['grant']>[0]) {
    return this.connection(client => this.transaction(client, async () => {
      const partner = await client.query<{ id: string }>(`SELECT id FROM identity.partners WHERE code = $1 AND status = 'active'`, [input.partnerCode]);
      if (!partner.rows[0]) return null;
      const inserted = await client.query<Row>(`INSERT INTO identity.partner_authorizations (partner_id, client_id, operation, granted_at, expires_at)
        VALUES ($1, $2, $3, $4, $5) RETURNING id, $6::STRING AS partner_code, granted_at, expires_at, revoked_at`,
      [partner.rows[0].id, input.principal.clientId, PARTNER_OFFER_OPERATION, input.grantedAt, input.expiresAt, input.partnerCode]);
      await this.record(client, input.principal, 'partner_authorization.granted', inserted.rows[0].id, input.traceId);
      return fromRow(inserted.rows[0]);
    }));
  }

  list(principal: Principal, limit: number) {
    return this.connection(async client => (await client.query<Row>(`${SELECT} WHERE a.client_id = $1 ORDER BY a.granted_at DESC, a.id LIMIT $2`,
      [principal.clientId, limit])).rows.map(fromRow));
  }

  revoke(principal: Principal, authorizationId: string, now: Date, traceId: string): Promise<RevokeAuthorizationResult> {
    return this.connection(client => this.transaction(client, async () => {
      const found = await client.query<Row>(`${SELECT} WHERE a.id = $1 AND a.client_id = $2 FOR UPDATE OF a`, [authorizationId, principal.clientId]);
      const row = found.rows[0];
      if (!row) return { kind: 'not_found' as const };
      if (row.revoked_at) return { kind: 'already_revoked' as const, authorization: fromRow(row) };
      if (row.expires_at.getTime() <= now.getTime()) return { kind: 'expired' as const, authorization: fromRow(row) };
      const updated = await client.query<{ revoked_at: Date }>('UPDATE identity.partner_authorizations SET revoked_at = clock_timestamp() WHERE id = $1 RETURNING revoked_at', [authorizationId]);
      await this.record(client, principal, 'partner_authorization.revoked', authorizationId, traceId);
      return { kind: 'revoked' as const, authorization: fromRow({ ...row, revoked_at: updated.rows[0].revoked_at }) };
    }));
  }

  find(partnerId: string, authorizationId: string) {
    return this.connection(async client => {
      const result = await client.query<{ client_id: string; subject_token: string; expires_at: Date }>(
        `SELECT a.client_id, c.subject_token, a.expires_at
         FROM identity.partner_authorizations a
         JOIN identity.clients c ON c.id = a.client_id
         JOIN identity.partners p ON p.id = a.partner_id
         WHERE a.id = $1 AND a.partner_id = $2 AND a.operation = $3 AND a.revoked_at IS NULL
           AND a.granted_at <= clock_timestamp() AND a.expires_at > clock_timestamp()
           AND c.status = 'active' AND p.status = 'active'`, [authorizationId, partnerId, PARTNER_OFFER_OPERATION]);
      const row = result.rows[0];
      return row ? { clientId: row.client_id, subjectToken: row.subject_token, expiresAt: row.expires_at.toISOString() } : null;
    });
  }
}
