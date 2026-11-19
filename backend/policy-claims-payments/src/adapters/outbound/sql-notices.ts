import { Client } from 'pg';
import type { NoticeRecord, NoticeStore } from '../../application/ports/notice';
import { claimNoticeFrom, dispatchConsumer, noticeEventTypes, noticeFrom, receiptConsumer, type DispatchOutcome, type ReceiptOutcome } from '../../domain/notice';

type Row = { event_id: string; event_type: string; payload: unknown; created_at: Date; dispatch: string | null; dispatched_at: Date | null; receipt: string | null };
const LIMIT = 20;
const SELECT = `SELECT o.event_id, o.event_type, o.payload, o.created_at, d.outcome AS dispatch, d.processed_at AS dispatched_at, r.outcome AS receipt
  FROM policy.outbox_events o
  LEFT JOIN policy.inbox_events d ON d.event_id = o.event_id AND d.consumer = '${dispatchConsumer}'
  LEFT JOIN policy.inbox_events r ON r.event_id = o.event_id AND r.consumer = '${receiptConsumer}'`;

// The customer's claim notices are stored with the claim decision, addressed to the customer's subject: the claim only gives their policy.
type ClaimRow = { event_id: string; policy_id: string; created_at: Date; dispatch: string | null; dispatched_at: Date | null; receipt: string | null };
const CLAIM_SELECT = `SELECT n.event_id, c.policy_id, n.created_at, d.outcome AS dispatch, d.processed_at AS dispatched_at, r.outcome AS receipt
  FROM policy.claim_notices n JOIN policy.claims c ON c.id = n.claim_id
  LEFT JOIN policy.inbox_events d ON d.event_id = n.event_id AND d.consumer = '${dispatchConsumer}'
  LEFT JOIN policy.inbox_events r ON r.event_id = n.event_id AND r.consumer = '${receiptConsumer}'`;

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

  // The owner is the client named inside the stored notice. Only the two notice types are read, and only the latest ones.
  async recent(clientId: string, since: Date, subjectToken?: string): Promise<NoticeRecord[]> {
    return this.run(async db => {
      const result = await db.query<Row>(`${SELECT} WHERE o.event_type = ANY($2::STRING[]) AND o.payload->>'clientId' = $1 AND o.created_at > $3
        ORDER BY o.created_at DESC, o.event_id LIMIT ${LIMIT}`, [clientId, [...noticeEventTypes], since]);
      const found = result.rows.map(record).filter((value): value is NoticeRecord => value !== null);
      if (!subjectToken) return found;
      const claims = await db.query<ClaimRow>(`${CLAIM_SELECT} WHERE n.audience = 'customer' AND n.recipient = $1 AND n.created_at > $2
        ORDER BY n.created_at DESC, n.event_id LIMIT ${LIMIT}`, [subjectToken, since]);
      return [...found, ...claims.rows.map(claimRecord).filter((value): value is NoticeRecord => value !== null)]
        .sort((a, b) => b.notice.occurredAt.localeCompare(a.notice.occurredAt) || a.notice.eventId.localeCompare(b.notice.eventId)).slice(0, LIMIT);
    });
  }

  async find(clientId: string, eventId: string, subjectToken?: string): Promise<NoticeRecord | null> {
    return this.run(async db => {
      const result = await db.query<Row>(`${SELECT} WHERE o.event_id = $2 AND o.event_type = ANY($3::STRING[]) AND o.payload->>'clientId' = $1`, [clientId, eventId, [...noticeEventTypes]]);
      if (result.rows[0]) return record(result.rows[0]);
      if (!subjectToken) return null;
      const claim = await db.query<ClaimRow>(`${CLAIM_SELECT} WHERE n.event_id = $2 AND n.audience = 'customer' AND n.recipient = $1`, [subjectToken, eventId]);
      return claim.rows[0] ? claimRecord(claim.rows[0]) : null;
    });
  }

  // The inbox key is the event and the consumer, so a second record of the same decision changes nothing.
  async record(eventId: string, eventType: string, consumer: string, outcome: string, traceId: string): Promise<'recorded' | 'exists'> {
    return this.run(async db => {
      const result = await db.query(`INSERT INTO policy.inbox_events(event_id, consumer, event_type, event_version, outcome, correlation_id)
        VALUES($1, $2, $3, 1, $4, $5) ON CONFLICT (event_id, consumer) DO NOTHING`, [eventId, consumer, eventType, outcome, traceId]);
      return result.rowCount === 1 ? 'recorded' : 'exists';
    });
  }
}
