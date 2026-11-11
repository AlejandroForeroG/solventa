import { Client } from 'pg';
import { readPartnerQuota } from './partner-quotas';
import type { PartnerPortalPermissions } from '../../application/api-access';

export class SqlPartnerPortalGrants implements PartnerPortalPermissions {
  constructor(private readonly connectionString: string) {}
  async find(principal: Parameters<PartnerPortalPermissions['find']>[0], identity: Parameters<PartnerPortalPermissions['find']>[1]) {
    const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1500, query_timeout: 1500, statement_timeout: 1500 });
    db.on('error', () => {});
    try {
      await db.connect();
      const result = await db.query<{ partner_id: string; code: string; expires_at: Date; credential_id: string | null; scopes: string[]; credential_expires_at: Date; revoked_at: Date | null; observed_at: Date }>(`WITH permitted AS (SELECT p.id AS partner_id,p.code,
        least(g.expires_at,s.expires_at,clock_timestamp()+interval '5 seconds') AS expires_at
        FROM identity.partner_portal_grants g JOIN identity.partners p ON p.id=g.partner_id
        JOIN identity.clients c ON c.id=g.client_id JOIN identity.authentication_sessions s ON s.client_id=c.id
        JOIN identity.external_identities e ON e.client_id=c.id AND e.provider='workos'
        WHERE c.id=$1 AND c.subject_token=$2 AND c.status='active' AND p.status='active'
          AND s.provider='workos' AND s.provider_session=$3 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
          AND e.provider_subject=$4 AND g.revoked_at IS NULL AND g.granted_at<=clock_timestamp() AND g.expires_at>clock_timestamp()
        LIMIT 1) SELECT p.*,k.id AS credential_id,k.scopes,k.expires_at AS credential_expires_at,k.revoked_at,statement_timestamp() AS observed_at
        FROM permitted p LEFT JOIN identity.partner_credentials k ON k.partner_id=p.partner_id
        ORDER BY k.created_at DESC,k.id DESC LIMIT 21`,
      [principal.clientId, principal.subjectToken, identity.sessionReference, identity.providerSubject]);
      const row = result.rows[0];
      const credentials = result.rows.flatMap(r => r.credential_id === null ? [] : [{ id: r.credential_id, scopes: r.scopes,
        expiresAt: r.credential_expires_at.toISOString(), status: r.revoked_at ? 'revoked' as const
          : r.credential_expires_at.getTime() <= r.observed_at.getTime() ? 'expired' as const : 'active' as const }] );
      const quota = row ? await readPartnerQuota(db, row.partner_id) : undefined;
      return row ? { quota, expiresAt: row.expires_at.toISOString(), partnerId: row.partner_id, code: row.code,
        credentials: credentials.slice(0, 20), hasMoreCredentials: credentials.length > 20 } : null;
    } finally { await db.end().catch(() => {}); }
  }
}
