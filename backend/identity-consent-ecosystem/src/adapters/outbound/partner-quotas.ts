import { Client } from 'pg';
import type { PartnerQuota, PartnerQuotas, QuotaDenial } from '../../application/partner-quota';

type QuotaRow = { daily_limit: string; used: string; window_start: string; resets_at: Date; tracking_since: Date; observed_at: Date };
const settings = `SELECT coalesce(o.daily_limit,p.daily_limit) AS daily_limit,p.tracking_since
  FROM identity.partner_quota_policy p JOIN identity.partners k ON k.id=$1 AND k.status='active'
  LEFT JOIN identity.partner_quota_overrides o ON o.partner_id=k.id WHERE p.id=true`;
const unavailable = { allowed: false, error: 'access_unavailable', status: 503 } as const;

export async function readPartnerQuota(db: Client, partnerId: string): Promise<PartnerQuota> {
  const row = (await db.query<QuotaRow>(`WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS at), config AS (${settings})
    SELECT c.daily_limit::STRING,coalesce(w.used,0)::STRING AS used,
      (t.at AT TIME ZONE 'UTC')::DATE::STRING AS window_start,
      (((t.at AT TIME ZONE 'UTC')::DATE+1)::TIMESTAMP AT TIME ZONE 'UTC') AS resets_at,c.tracking_since,t.at AS observed_at
    FROM config c CROSS JOIN tick t LEFT JOIN identity.partner_quota_windows w
      ON w.partner_id=$1 AND w.window_start=(t.at AT TIME ZONE 'UTC')::DATE`, [partnerId])).rows[0];
  if (!row) throw Error('quota_configuration_unavailable');
  const limit = Number(row.daily_limit), used = Number(row.used);
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(used) || used < 0) throw Error('quota_record_invalid');
  return { configured: true, limit, used, remaining: Math.max(0,limit-used), windowStart: row.window_start+'T00:00:00.000Z',
    resetsAt: row.resets_at.toISOString(), trackingSince: row.tracking_since.toISOString(), updatedAt: row.observed_at.toISOString(), timeZone: 'UTC' };
}

export class SqlPartnerQuotas implements PartnerQuotas {
  constructor(private readonly connectionString: string) {}
  async admit(partnerId: string): Promise<{ allowed: true } | QuotaDenial> {
    for (let attempt=0; attempt<2; attempt++) {
      const db=new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1000, query_timeout: 1200, statement_timeout: 1200 });
      db.on('error',()=>{});
      let committing=false;
      try {
        await db.connect(); await db.query('BEGIN');
        const result=await db.query<{ window_start: string }>(`WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS at), config AS (${settings})
          INSERT INTO identity.partner_quota_windows(partner_id,window_start,used,first_admitted_at,last_admitted_at)
          SELECT $1,(t.at AT TIME ZONE 'UTC')::DATE,1,t.at,t.at FROM config c CROSS JOIN tick t
          ON CONFLICT(partner_id,window_start) DO UPDATE SET used=partner_quota_windows.used+1,last_admitted_at=greatest(partner_quota_windows.last_admitted_at,excluded.last_admitted_at)
          WHERE partner_quota_windows.used<(SELECT daily_limit FROM config)
          RETURNING window_start::STRING`, [partnerId]);
        const quota=await readPartnerQuota(db,partnerId);
        // Waiting on the counter must never debit the previous UTC day.
        if ((result.rows[0] && result.rows[0].window_start!==quota.windowStart.slice(0,10)) || (result.rowCount===0 && quota.remaining>0)) {
          await db.query('ROLLBACK'); continue;
        }
        const answer = result.rowCount===1 ? { allowed: true } as const
          : { allowed: false, error: 'quota_exceeded', status: 429, retryAfter: Math.max(1,Math.min(86400,Math.ceil((Date.parse(quota.resetsAt)-Date.parse(quota.updatedAt))/1000))) } as const;
        committing=true; await db.query('COMMIT'); return answer;
      } catch (error) {
        await db.query('ROLLBACK').catch(()=>{});
        if (!committing && error && typeof error==='object' && 'code' in error && error.code==='40001' && attempt===0) continue;
        return unavailable;
      } finally { await db.end().catch(()=>{}); }
    }
    return unavailable;
  }
}
