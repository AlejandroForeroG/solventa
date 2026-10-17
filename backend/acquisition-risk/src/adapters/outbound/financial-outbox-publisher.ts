import { Client } from 'pg';
import type { AcceptanceEvent } from '../../application/ports/offer-store';
import { HmacOfferIntegrity } from './hmac-offer-integrity';

export interface FinancialEventQueue { send(event: AcceptanceEvent): Promise<void> }
export async function sendWithinDeadline(delivery: Promise<void>, deadlineMs = 5000): Promise<void> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 5000) throw new Error('financial_queue_deadline_invalid');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([delivery, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('financial_queue_deadline')), deadlineMs); })]);
  } finally { clearTimeout(timer); }
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
// Do not publish additional keys: a valid signature over canonical fields cannot authorize appended PII.
function envelope(value: unknown, environment: string): value is AcceptanceEvent {
  if (!record(value) || !exact(value, ['version', 'eventType', 'eventId', 'environment', 'synthetic', 'occurredAt', 'correlationId', 'payload', 'signature'])
    || value.environment !== environment || value.synthetic !== true || value.version !== 1 || value.eventType !== 'offer.accepted'
    || typeof value.signature !== 'string' || !record(value.payload)) return false;
  const p = value.payload;
  if (!exact(p, ['acceptanceId', 'offerId', 'offerVersion', 'clientId', 'subjectToken', 'product', 'premium', 'currency', 'coverage', 'effectiveFrom', 'effectiveUntil', 'expiresAt', 'ruleVersion', 'acceptedAt']) || !record(p.coverage)) return false;
  const coverage = p.coverage;
  return (coverage.kind === 'mortgage_life' && exact(coverage, ['kind', 'sumInsured']))
    || (coverage.kind === 'flight_delay' && exact(coverage, ['kind', 'flightReference', 'thresholdMinutes', 'payoutAmount']));
}

export class FinancialOutboxPublisher {
  constructor(private readonly deps: { connectionString: string; queue: FinancialEventQueue; integrity: HmacOfferIntegrity; environment: string; sendDeadlineMs?: number }) {}
  async publish(): Promise<{ claimed: number; published: number; deferred: number; deadLetter: number; oldestPendingAgeMs: number }> {
    const counts = { claimed: 0, published: 0, deferred: 0, deadLetter: 0, oldestPendingAgeMs: 0 };
    const client = new Client({ connectionString: this.deps.connectionString, connectionTimeoutMillis: 3000, query_timeout: 3000 });
    client.on('error', () => {});
    const lease = crypto.randomUUID();
    try {
      await client.connect();
      const claimed = await client.query<{ event_id: string; payload: unknown; attempts: string; correlation_id: string; aggregate_id: string }>(`UPDATE acquisition.outbox_events SET status='publishing',lease_owner=$1,lease_until=now()+interval '120 seconds',attempts=attempts+1
        WHERE event_id IN (SELECT event_id FROM acquisition.outbox_events WHERE event_type='offer.accepted' AND
          ((status='pending' AND available_at<=now()) OR (status='publishing' AND lease_until<=now())) AND attempts<5 ORDER BY created_at LIMIT 10)
          AND ((status='pending' AND available_at<=now()) OR (status='publishing' AND lease_until<=now()))
        RETURNING event_id,payload,attempts,correlation_id,aggregate_id`, [lease]);
      counts.claimed = claimed.rows.length;
      for (const row of claimed.rows) {
        let permanent = false;
        try {
          if (!envelope(row.payload, this.deps.environment) || row.payload.eventId !== row.event_id || row.payload.correlationId !== row.correlation_id
            || row.payload.payload.offerId !== row.aggregate_id || !await this.deps.integrity.verifyEvent(row.payload)) { permanent = true; throw new Error('invalid_financial_event'); }
          await sendWithinDeadline(this.deps.queue.send(row.payload), this.deps.sendDeadlineMs);
          const confirmed = await client.query(`UPDATE acquisition.outbox_events SET status='published',published_at=now(),lease_owner=NULL,lease_until=NULL WHERE event_id=$1 AND status='publishing' AND lease_owner=$2 AND lease_until>now()`, [row.event_id, lease]);
          if (confirmed.rowCount === 1) counts.published++;
        } catch {
          const dead = permanent || Number(row.attempts) >= 5;
          await client.query(`UPDATE acquisition.outbox_events SET status=$3,available_at=now()+interval '1 minute',lease_owner=NULL,lease_until=NULL WHERE event_id=$1 AND status='publishing' AND lease_owner=$2 AND lease_until>now()`, [row.event_id, lease, dead ? 'dead_letter' : 'pending']);
          if (dead) counts.deadLetter++; else counts.deferred++;
        }
      }
      // An interrupted fifth attempt must become visible rather than remain in an unclaimable lease.
      await client.query("UPDATE acquisition.outbox_events SET status='dead_letter',lease_owner=NULL,lease_until=NULL WHERE event_type='offer.accepted' AND status='publishing' AND lease_until<=now() AND attempts>=5");
      const lag = await client.query<{ age_ms: string | null }>("SELECT EXTRACT(EPOCH FROM (now()-MIN(created_at)))*1000 AS age_ms FROM acquisition.outbox_events WHERE event_type='offer.accepted' AND status IN ('pending','publishing')");
      counts.oldestPendingAgeMs = Math.max(0, Math.round(Number(lag.rows[0]?.age_ms ?? 0)));
      return counts;
    } finally { await client.end().catch(() => {}); }
  }
}
