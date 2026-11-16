import { Client } from 'pg';
import type { PartnerPortalStore, PortalActivity, PortalQuery } from '../../application/partner-portal';

export class SqlPartnerPortal implements PartnerPortalStore {
  constructor(private readonly connectionString: string) {}
  async read(partnerId: string, query: PortalQuery): Promise<PortalActivity> {
    const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1500, query_timeout: 2000, statement_timeout: 2000 });
    db.on('error', () => {});
    try {
      await db.connect();
      // One statement gives aggregates and the recent list the same consistent snapshot.
      const result = await db.query<{ updated_at: Date; completed: string; accepted: string; preliminary: string; declined: string; total: string; items: PortalActivity['items'] }>(`WITH facts AS (
        SELECT id,coalesce(quote_code,id::STRING) AS reference,'quote' AS kind,created_at AS occurred_at,'completed' AS result,rule_version
        FROM acquisition.quotes WHERE partner_id=$1::UUID AND status='completed'
          AND created_at >= $2::TIMESTAMPTZ AND created_at < $3::TIMESTAMPTZ + INTERVAL '1 day'
        UNION ALL
        SELECT id,id::STRING AS reference,'offer_decision' AS kind,decided_at AS occurred_at,outcome AS result,rule_version
        FROM acquisition.underwriting_decisions WHERE input_snapshot->'channel'->>'kind'='partner'
          AND input_snapshot->'channel'->>'partnerId'=$1::STRING
          AND decided_at >= $2::TIMESTAMPTZ AND decided_at < $3::TIMESTAMPTZ + INTERVAL '1 day'
          AND outcome IN ('accepted','preliminary','declined')
      ), recent AS (SELECT * FROM facts ORDER BY occurred_at DESC,id DESC,kind DESC LIMIT 20)
      SELECT statement_timestamp() AS updated_at,count(*) AS total,
        count(*) FILTER (WHERE result='completed') AS completed,count(*) FILTER (WHERE result='accepted') AS accepted,
        count(*) FILTER (WHERE result='preliminary') AS preliminary,count(*) FILTER (WHERE result='declined') AS declined,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'reference',reference,'kind',kind,'occurredAt',occurred_at,'result',result,'ruleVersion',rule_version)
          ORDER BY occurred_at DESC,id DESC,kind DESC),'[]'::JSONB) FROM recent) AS items FROM facts`,
      [partnerId, query.from + 'T00:00:00Z', query.to + 'T00:00:00Z']);
      const row = result.rows[0];
      if (!row || [row.completed,row.accepted,row.preliminary,row.declined,row.total].some(n => !Number.isSafeInteger(Number(n)) || Number(n) < 0)) throw new Error('invalid_activity_counts');
      return { updatedAt: row.updated_at.toISOString(), totals: { completed: Number(row.completed), accepted: Number(row.accepted), preliminary: Number(row.preliminary), declined: Number(row.declined) }, items: row.items, hasMore: Number(row.total) > 20 };
    } finally { await db.end().catch(() => {}); }
  }
}
