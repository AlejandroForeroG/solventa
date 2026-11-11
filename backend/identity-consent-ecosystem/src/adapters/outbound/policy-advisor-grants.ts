import { Client } from 'pg';
import type { AdvisorPermissions, EligibleAdvisor } from '../../application/advisor-access';

export class SqlPolicyAdvisorGrants implements AdvisorPermissions {
  constructor(private readonly connectionString: string) {}
  private async query(text: string, values: string[]) {
    const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1500, query_timeout: 1500, statement_timeout: 1500 });
    db.on('error', () => {});
    try {
      await db.connect();
      return (await db.query<{ reference: string; client_id: string; subject_token: string; expires_at: Date }>(text, values)).rows[0];
    } finally { await db.end().catch(() => {}); }
  }
  async find(principal: Parameters<AdvisorPermissions['find']>[0], identity: Parameters<AdvisorPermissions['find']>[1]) {
    const row = await this.query(`SELECT g.id AS reference,c.id AS client_id,c.subject_token,
      least(g.expires_at,s.expires_at,clock_timestamp()+interval '5 seconds') AS expires_at
      FROM identity.policy_advisor_grants g JOIN identity.clients c ON c.id=g.client_id
      JOIN identity.authentication_sessions s ON s.client_id=c.id
      JOIN identity.external_identities e ON e.client_id=c.id AND e.provider='workos'
      WHERE c.id=$1 AND c.subject_token=$2 AND c.status='active' AND s.provider='workos'
        AND s.provider_session=$3 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
        AND e.provider_subject=$4 AND g.revoked_at IS NULL AND g.granted_at<=clock_timestamp() AND g.expires_at>clock_timestamp()
      LIMIT 1`, [principal.clientId, principal.subjectToken, identity.sessionReference, identity.providerSubject]);
    return row ? { reference: row.reference, expiresAt: row.expires_at.toISOString() } : null;
  }
  async eligible(reference: string): Promise<EligibleAdvisor | null> {
    const row = await this.query(`SELECT g.id AS reference,c.id AS client_id,c.subject_token,
      least(g.expires_at,clock_timestamp()+interval '5 seconds') AS expires_at
      FROM identity.policy_advisor_grants g JOIN identity.clients c ON c.id=g.client_id
      WHERE g.id=$1 AND c.status='active' AND g.revoked_at IS NULL
        AND g.granted_at<=clock_timestamp() AND g.expires_at>clock_timestamp()`, [reference]);
    return row ? { reference: row.reference, principal: { clientId: row.client_id, subjectToken: row.subject_token }, expiresAt: row.expires_at.toISOString() } : null;
  }
}
