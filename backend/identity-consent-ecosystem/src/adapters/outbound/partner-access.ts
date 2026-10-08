import { Client } from 'pg';
import type { PartnerAccessRepository, PartnerCredential } from '../../application/api-access';

export class SqlPartnerAccess implements PartnerAccessRepository {
  constructor(private readonly connectionString: string) {}

  async find(provider: string, reference: string): Promise<PartnerCredential | null> {
    const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1000, query_timeout: 1000, statement_timeout: 1000 });
    db.on('error', () => {});
    try {
      await db.connect();
      const result = await db.query<{ partner_id: string; id: string; scopes: string[] }>(
        `SELECT c.partner_id, c.id, c.scopes FROM identity.partner_credentials c
         JOIN identity.partners p ON p.id=c.partner_id
         WHERE c.provider=$1 AND c.credential_reference=$2 AND p.status='active'
         AND c.revoked_at IS NULL AND c.expires_at>now() LIMIT 1`, [provider, reference]);
      const row = result.rows[0];
      return row ? { partnerId: row.partner_id, credentialId: row.id, scopes: row.scopes } : null;
    } finally { await db.end().catch(() => {}); }
  }
}
