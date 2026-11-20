import { Client } from 'pg';
import type { NoticeRecord, NoticeStore } from '../../application/ports/notice';
import { claimNoticeFrom, noticeConsumers, noticeEventTypes, noticeFrom, type DispatchOutcome, type NoticeDecisionCapture, type ReceiptOutcome } from '../../domain/notice';

type Row = { event_id: string; event_type: string; payload: unknown; created_at: Date; dispatch: string | null; dispatched_at: Date | null; receipt: string | null };
const LIMIT = 20;
const SELECT = `SELECT o.event_id, o.event_type, o.payload, o.created_at, d.outcome AS dispatch, d.processed_at AS dispatched_at, r.outcome AS receipt
  FROM policy.outbox_events o
  LEFT JOIN policy.inbox_events d ON d.event_id = o.event_id AND d.consumer = $4
  LEFT JOIN policy.inbox_events r ON r.event_id = o.event_id AND r.consumer = $5`;

// The customer's claim notices are stored with the claim decision, addressed to the customer's subject: the claim only gives their policy.
type ClaimRow = { event_id: string; policy_id: string; created_at: Date; dispatch: string | null; dispatched_at: Date | null; receipt: string | null };
const CLAIM_SELECT = `SELECT n.event_id, c.policy_id, n.created_at, d.outcome AS dispatch, d.processed_at AS dispatched_at, r.outcome AS receipt
  FROM policy.claim_notices n JOIN policy.claims c ON c.id = n.claim_id
  LEFT JOIN policy.inbox_events d ON d.event_id = n.event_id AND d.consumer = $3
  LEFT JOIN policy.inbox_events r ON r.event_id = n.event_id AND r.consumer = $4`;

function decided(dispatch: string | null, receipt: string | null, dispatchedAt: Date | null) {
  return { dispatch: dispatch === 'offered' || dispatch === 'suppressed_preference' ? dispatch as DispatchOutcome : null, dispatchedAt: dispatchedAt?.toISOString() ?? null,
    receipt: receipt === 'presented' || receipt === 'permission_denied' ? receipt as ReceiptOutcome : null };
}

function claimRecord(row: ClaimRow): NoticeRecord | null {
  const notice = claimNoticeFrom({ eventId: row.event_id, policyId: row.policy_id, createdAt: row.created_at });
  return notice ? { notice, ...decided(row.dispatch, row.receipt, row.dispatched_at) } : null;
}

function record(row: Row): NoticeRecord | null {
  const notice = noticeFrom({ eventId: row.event_id, eventType: row.event_type, payload: row.payload, createdAt: row.created_at });
  if (!notice) return null;
  const dispatch = row.dispatch === 'offered' || row.dispatch === 'suppressed_preference' ? row.dispatch as DispatchOutcome : null;
  const receipt = row.receipt === 'presented' || row.receipt === 'permission_denied' ? row.receipt as ReceiptOutcome : null;
  return { notice, dispatch, dispatchedAt: row.dispatched_at?.toISOString() ?? null, receipt };
}

export class SqlNotices implements NoticeStore {
  constructor(private readonly connectionString: string) {}

  private async run<T>(work: (db: Client) => Promise<T>): Promise<T> {
    const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1000, query_timeout: 1500 });
    db.on('error', () => {});
    try { await db.connect(); return await work(db); } finally { await db.end().catch(() => {}); }
  }

  // Only current notice types addressed to the owner are read, within the bounded history.
  async recent(clientId: string, since: Date, subjectToken?: string, destination?: string): Promise<NoticeRecord[]> {
    const consumers = noticeConsumers(destination);
    return this.run(async db => {
      const result = await db.query<Row>(`${SELECT} WHERE o.event_type = ANY($2::STRING[]) AND o.payload->>'clientId' = $1 AND o.created_at > $3
        ORDER BY o.created_at DESC, o.event_id LIMIT ${LIMIT}`, [clientId, [...noticeEventTypes], since, consumers.dispatch, consumers.receipt]);
      const found = result.rows.map(record).filter((value): value is NoticeRecord => value !== null);
      if (!subjectToken) return found;
      const claims = await db.query<ClaimRow>(`${CLAIM_SELECT} WHERE n.audience = 'customer' AND n.recipient = $1 AND n.created_at > $2
        ORDER BY n.created_at DESC, n.event_id LIMIT ${LIMIT}`, [subjectToken, since, consumers.dispatch, consumers.receipt]);
      return [...found, ...claims.rows.map(claimRecord).filter((value): value is NoticeRecord => value !== null)]
        .sort((a, b) => b.notice.occurredAt.localeCompare(a.notice.occurredAt) || a.notice.eventId.localeCompare(b.notice.eventId)).slice(0, LIMIT);
    });
  }

  async find(clientId: string, eventId: string, subjectToken?: string, destination?: string): Promise<NoticeRecord | null> {
    const consumers = noticeConsumers(destination);
    return this.run(async db => {
      const result = await db.query<Row>(`${SELECT} WHERE o.event_id = $2 AND o.event_type = ANY($3::STRING[]) AND o.payload->>'clientId' = $1`, [clientId, eventId, [...noticeEventTypes], consumers.dispatch, consumers.receipt]);
      if (result.rows[0]) return record(result.rows[0]);
      if (!subjectToken) return null;
      const claim = await db.query<ClaimRow>(`${CLAIM_SELECT} WHERE n.event_id = $2 AND n.audience = 'customer' AND n.recipient = $1`, [subjectToken, eventId, consumers.dispatch, consumers.receipt]);
      return claim.rows[0] ? claimRecord(claim.rows[0]) : null;
    });
  }

  // The inbox key is the event and the consumer, so a second record of the same decision changes nothing.
  async record(eventId: string, eventType: string, consumer: string, outcome: string, traceId: string, capture?: NoticeDecisionCapture): Promise<'recorded' | 'exists'> {
    if (/^notice\.(dispatch|receipt)\.v2:/.test(consumer) && !capture) throw new Error('notice_capture_required');
    return this.run(async db => {
      if (capture) {
        const result = await db.query(`WITH recorded AS (
          INSERT INTO policy.inbox_events(event_id,consumer,event_type,event_version,outcome,correlation_id)
          VALUES($1,$2,$3,1,$4,$5) ON CONFLICT(event_id,consumer) DO NOTHING RETURNING event_id
        ), audited AS (
          INSERT INTO policy.audit_events(actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
          SELECT $6,$7,'notice_delivery',event_id,$4,$5,now()+INTERVAL '90 days' FROM recorded RETURNING id
        ), captured AS (
          INSERT INTO policy.outbox_events(event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id)
          SELECT gen_random_uuid(),'notice_delivery',event_id,$7,1,$8::JSONB,$5 FROM recorded RETURNING event_id
        ) SELECT recorded.event_id FROM recorded JOIN audited ON true JOIN captured ON true`,
        [eventId,consumer,eventType,outcome,traceId,capture.inputs.clientId,`policy.notice.delivery.${capture.inputs.operation}`,JSON.stringify(capture)]);
        return result.rowCount === 1 ? 'recorded' : 'exists';
      }
      const result = await db.query(`INSERT INTO policy.inbox_events(event_id, consumer, event_type, event_version, outcome, correlation_id)
        VALUES($1, $2, $3, 1, $4, $5) ON CONFLICT (event_id, consumer) DO NOTHING`, [eventId, consumer, eventType, outcome, traceId]);
      return result.rowCount === 1 ? 'recorded' : 'exists';
    });
  }
}
