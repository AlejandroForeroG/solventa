import { Client } from 'pg';
import type { MobileNoticeDestinations } from '../../application/api-access';

export class SqlNoticeDestinations implements MobileNoticeDestinations {
  constructor(private readonly connectionString: string) {}

  async find(principal: Parameters<MobileNoticeDestinations['find']>[0], identity: Parameters<MobileNoticeDestinations['find']>[1]) {
    const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1000, query_timeout: 1500 });
    db.on('error', () => {});
    try {
      await db.connect();
      const result = await db.query<{ installation_id: string }>(`SELECT lower(split_part(d.device_reference,':',3)) AS installation_id
        FROM identity.registered_devices d JOIN identity.clients c ON c.id=d.client_id
        JOIN identity.authentication_sessions s ON s.client_id=c.id
        JOIN identity.external_identities e ON e.client_id=c.id AND e.provider='workos'
        WHERE c.id=$1 AND c.subject_token=$2 AND c.status='active'
          AND s.provider='workos' AND s.provider_session=$3 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
          AND e.provider_subject=$4 AND d.revoked_at IS NULL
          AND split_part(d.device_reference,':',1)='mobile-v1' AND split_part(d.device_reference,':',2)=$3
        LIMIT 2`, [principal.clientId, principal.subjectToken, identity.sessionReference, identity.providerSubject]);
      // A corrupt or ambiguous binding must not select an arbitrary destination.
      return result.rows.length === 1 ? result.rows[0]!.installation_id : null;
    } finally { await db.end().catch(() => {}); }
  }
}
