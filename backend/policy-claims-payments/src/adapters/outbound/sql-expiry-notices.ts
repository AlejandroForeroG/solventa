import { Client } from 'pg';
import type { ExpiryAnnouncer } from '../../application/ports/notice';

export class SqlExpiryNotices implements ExpiryAnnouncer {
  constructor(private readonly connectionString: string) {}

  // The event id is derived from the policy and its expiry instant, so the primary key makes a second run, or a concurrent one, a no-op.
  // A policy that was already modified, renewed or cancelled is not about to expire as far as its owner is concerned.
  async announceExpiring(now: Date, windowMs: number): Promise<number> {
    const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1000, query_timeout: 5000 });
    db.on('error', () => {});
    try {
      await db.connect();
      const result = await db.query(`INSERT INTO policy.outbox_events(event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id)
        SELECT (substr(h.digest,1,12) || '4' || substr(h.digest,14,3) || '8' || substr(h.digest,18,15))::UUID, 'policy', p.id, 'policy.expiry.notice', 1,
          jsonb_build_object('category','policy_expiring','clientId',f.client_id::STRING,'policyId',p.id::STRING,
            'expiresAt',to_char(p.effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), gen_random_uuid()
        FROM policy.policies p
        JOIN policy.financial_contracts f ON f.policy_id = p.id
        LEFT JOIN policy.policy_lifecycle_changes lc ON lc.policy_id = p.id
        CROSS JOIN LATERAL (SELECT md5('policy-expiry-v1:' || p.id::STRING || ':' || extract(epoch FROM p.effective_until)::STRING) AS digest) h
        WHERE p.status = 'issued' AND lc.policy_id IS NULL AND p.effective_until > $1::TIMESTAMPTZ AND p.effective_until <= $1::TIMESTAMPTZ + ($2::INT8 * interval '1 millisecond')
        ON CONFLICT (event_id) DO NOTHING`, [now, windowMs]);
      return result.rowCount ?? 0;
    } finally { await db.end().catch(() => {}); }
  }
}
