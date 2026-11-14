import { Client } from 'pg';
import type { ReportOperation, ReportPermissions } from '../../application/api-access';

export class SqlReportAccessGrants implements ReportPermissions {
  constructor(private readonly connectionString: string) {}
  async find(principal: Parameters<ReportPermissions['find']>[0], identity: Parameters<ReportPermissions['find']>[1], operation: ReportOperation) {
    const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1500, query_timeout: 1500, statement_timeout: 1500 });
    db.on('error', () => {});
    try {
      await db.connect();
      const result = await db.query<{ expires_at: Date }>(`SELECT least(g.expires_at,s.expires_at,clock_timestamp()+interval '5 seconds') AS expires_at
        FROM identity.report_access_grants g JOIN identity.clients c ON c.id=g.client_id
        JOIN identity.authentication_sessions s ON s.client_id=c.id
        JOIN identity.external_identities e ON e.client_id=c.id AND e.provider='workos'
        WHERE c.id=$1 AND c.subject_token=$2 AND c.status='active'
          AND s.provider='workos' AND s.provider_session=$3 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
          AND e.provider_subject=$4 AND g.operation=$5 AND g.revoked_at IS NULL AND g.granted_at<=clock_timestamp() AND g.expires_at>clock_timestamp()
        ORDER BY g.expires_at DESC LIMIT 1`, [principal.clientId, principal.subjectToken, identity.sessionReference, identity.providerSubject, operation]);
      return result.rows[0] ? { expiresAt: result.rows[0].expires_at.toISOString() } : null;
    } finally { await db.end().catch(() => {}); }
  }
}
