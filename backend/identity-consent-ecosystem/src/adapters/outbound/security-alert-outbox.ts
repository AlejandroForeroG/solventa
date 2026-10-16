import { Client } from 'pg';
import { canonicalSecurityId } from '../../domain/security-decision';
import { securityAlertPolicy } from '../../application/security-alerts';
import type { SecurityAlertOutbox } from '../../application/ports/security-alerts';

type EventRow = {
  event_id: string; event_type: string; event_version: string; aggregate_type: string; aggregate_id: string;
  correlation_id: string; payload: unknown; attempts: string; created_at: Date;
  lease_until: Date | null; status: string;
};

export class SqlSecurityAlertOutbox implements SecurityAlertOutbox {
  constructor(private readonly connectionString: string) {}

  private async connection<T>(run: (db: Client) => Promise<T>): Promise<T> {
    const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1_000,
      query_timeout: 1_000, statement_timeout: 1_000 });
    db.on('error', () => {});
    try { await db.connect(); return await run(db); }
    catch { throw new Error('security_alert_outbox_unavailable'); }
    finally { await db.end().catch(() => {}); }
  }

  async claim(input: { leaseOwner: string; limit: number; leaseMs: number; maxAttempts: number }) {
    const owner = canonicalSecurityId(input.leaseOwner);
    if (!owner || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > securityAlertPolicy.batchSize
      || input.leaseMs !== securityAlertPolicy.leaseMs || input.maxAttempts !== securityAlertPolicy.maxAttempts) {
      throw new Error('invalid_security_alert_claim');
    }
    return this.connection(async db => {
      // One statement claims only this owner's security events. Serializable SQL and the
      // guarded UPDATE preserve exclusivity even when competing claims are retried by SQL.
      const rows = await db.query<EventRow>(
        `WITH candidates AS (
           SELECT event_id FROM identity.outbox_events
           WHERE event_type IN ('identity.security_denied','identity.device_registration_denied')
             AND ((status='pending' AND available_at<=now()) OR (status='publishing' AND lease_until<=now()))
           ORDER BY available_at, event_id LIMIT $1 FOR UPDATE SKIP LOCKED
         )
         UPDATE identity.outbox_events AS event
         SET status=CASE WHEN attempts >= $4 THEN 'dead_letter' ELSE 'publishing' END,
             attempts=CASE WHEN attempts >= $4 THEN attempts ELSE attempts+1 END,
             lease_owner=CASE WHEN attempts >= $4 THEN NULL ELSE $2 END,
             lease_until=CASE WHEN attempts >= $4 THEN NULL ELSE now()+($3::INT8 * INTERVAL '1 millisecond') END
         FROM candidates WHERE event.event_id=candidates.event_id
           AND event.event_type IN ('identity.security_denied','identity.device_registration_denied')
           AND ((event.status='pending' AND event.available_at<=now()) OR (event.status='publishing' AND event.lease_until<=now()))
         RETURNING event.event_id,event.event_type,event.event_version,event.aggregate_type,event.aggregate_id,
           event.correlation_id,event.payload,event.attempts,event.created_at,event.lease_until,event.status`,
        [input.limit, owner, input.leaseMs, input.maxAttempts]);
      return { deadLettered: rows.rows.filter(row => row.status === 'dead_letter').length,
        events: rows.rows.filter(row => row.status === 'publishing').map(row => ({
          eventId: row.event_id, eventType: row.event_type, eventVersion: Number(row.event_version), aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id, correlationId: row.correlation_id, payload: row.payload,
          attempts: Number(row.attempts), createdAt: row.created_at.getTime(), leaseUntil: row.lease_until?.getTime() ?? 0,
        })) };
    });
  }

  async published(eventId: string, leaseOwner: string): Promise<boolean> {
    return this.connection(async db => {
      const result = await db.query(
        `UPDATE identity.outbox_events SET status='published',published_at=now(),lease_owner=NULL,lease_until=NULL
         WHERE event_id=$1 AND event_type IN ('identity.security_denied','identity.device_registration_denied') AND status='publishing'
           AND lease_owner=$2 AND lease_until>now()`, [eventId, leaseOwner]);
      return result.rowCount === 1;
    });
  }

  async failed(eventId: string, leaseOwner: string, retryDelayMs: number | null): Promise<boolean> {
    if (retryDelayMs !== null && (!Number.isInteger(retryDelayMs) || retryDelayMs < 1_000 || retryDelayMs > 8_000)) {
      throw new Error('invalid_security_alert_retry');
    }
    return this.connection(async db => {
      const result = await db.query(
        `UPDATE identity.outbox_events
         SET status=CASE WHEN $3::INT8 IS NULL OR attempts >= $4 THEN 'dead_letter' ELSE 'pending' END,
             available_at=CASE WHEN $3::INT8 IS NULL THEN available_at ELSE now()+($3::INT8 * INTERVAL '1 millisecond') END,
             lease_owner=NULL,lease_until=NULL
         WHERE event_id=$1 AND event_type IN ('identity.security_denied','identity.device_registration_denied') AND status='publishing'
           AND lease_owner=$2 AND lease_until>now()`, [eventId, leaseOwner, retryDelayMs, securityAlertPolicy.maxAttempts]);
      return result.rowCount === 1;
    });
  }
}
