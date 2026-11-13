import { Client } from 'pg';
import type { AssistanceOwner, AssistanceRequestStore, CreateOutcome } from '../../application/ports/assistance-request';
import type { AssistancePlace, AssistanceRequestRecord } from '../../domain/assistance-request';

const RETRYABLE = new Set(['40001', '23505']);
const AUDIT_RETENTION = "INTERVAL '90 days'";
type Db = Client;
type Row = { id: string; reference: string; provider_id: string; provider_kind: 'workshop' | 'expert' | 'roadside'; provider_name: string; provider_city: string; provider_address: string;
  provider_phone: string; provider_hours: string; place_kind: 'device' | 'address'; latitude: string | null; longitude: string | null; address: string | null; created_at: Date };
const COLUMNS = `id, reference, provider_id, provider_kind, provider_name, provider_city, provider_address, provider_phone, provider_hours, place_kind, latitude::STRING AS latitude,
  longitude::STRING AS longitude, address, created_at`;

function record(row: Row): AssistanceRequestRecord {
  const place: AssistancePlace = row.place_kind === 'device' ? { kind: 'device', latitude: Number(row.latitude), longitude: Number(row.longitude) } : { kind: 'address', address: row.address ?? '' };
  return { id: row.id, reference: row.reference, status: 'requested', place, createdAt: row.created_at.toISOString(),
    provider: { id: row.provider_id, kind: row.provider_kind, name: row.provider_name, city: row.provider_city, address: row.provider_address, phone: row.provider_phone, hours: row.provider_hours } };
}

export class SqlAssistanceRequests implements AssistanceRequestStore {
  constructor(private readonly connectionString: string) {}

  // A serialization conflict, a concurrent identical request or a colliding reference is retried as a whole: the second attempt sees what the first committed.
  private async run<T>(work: (db: Db) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1500, query_timeout: 1500 });
      db.on('error', () => {});
      try {
        await db.connect();
        await db.query('BEGIN');
        const result = await work(db);
        await db.query('COMMIT');
        return result;
      } catch (error) {
        await db.query('ROLLBACK').catch(() => {});
        if (attempt < 4 && RETRYABLE.has((error as { code?: string }).code ?? '')) continue;
        throw error;
      } finally { await db.end().catch(() => {}); }
    }
  }

  create({ owner, provider, place, idempotencyKey, requestHash, traceId, newReference }: Parameters<AssistanceRequestStore['create']>[0]): Promise<CreateOutcome> {
    return this.run<CreateOutcome>(async db => {
      const existing = (await db.query<Row & { request_hash: string }>(`SELECT ${COLUMNS}, request_hash FROM policy.assistance_requests WHERE subject_token = $1 AND idempotency_key = $2`,
        [owner.subjectToken, idempotencyKey])).rows[0];
      if (existing) return existing.request_hash === requestHash ? { status: 'replayed', request: record(existing) } : { status: 'idempotency_conflict' };
      const row = (await db.query<Row>(`INSERT INTO policy.assistance_requests (reference, subject_token, client_id, idempotency_key, request_hash, provider_id, provider_kind, provider_name,
          provider_city, provider_address, provider_phone, provider_hours, place_kind, latitude, longitude, address, location_authorized_at, correlation_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, CASE WHEN $13 = 'device' THEN now() ELSE NULL END, $17) RETURNING ${COLUMNS}`,
      [newReference(), owner.subjectToken, owner.clientId, idempotencyKey, requestHash, provider.id, provider.kind, provider.name, provider.city, provider.address, provider.phone,
        provider.hours, place.kind, place.kind === 'device' ? place.latitude : null, place.kind === 'device' ? place.longitude : null, place.kind === 'address' ? place.address : null, traceId])).rows[0];
      await this.audit(db, owner, 'assistance.request.create', row.id, traceId);
      return { status: 'created', request: record(row) };
    });
  }

  get(owner: AssistanceOwner, id: string): Promise<AssistanceRequestRecord | null> {
    return this.run(async db => {
      const row = (await db.query<Row>(`SELECT ${COLUMNS} FROM policy.assistance_requests WHERE id = $1 AND subject_token = $2`, [id, owner.subjectToken])).rows[0];
      return row ? record(row) : null;
    });
  }

  listOwn(owner: AssistanceOwner, limit: number): Promise<AssistanceRequestRecord[]> {
    return this.run(async db => (await db.query<Row>(`SELECT ${COLUMNS} FROM policy.assistance_requests WHERE subject_token = $1 ORDER BY created_at DESC, id LIMIT $2`,
      [owner.subjectToken, limit])).rows.map(record));
  }

  private audit(db: Db, owner: AssistanceOwner, action: string, requestId: string, traceId: string) {
    return db.query(`INSERT INTO policy.audit_events (actor_reference, action, resource_type, resource_id, outcome, correlation_id, retention_until)
      VALUES ($1, $2, 'assistance_request', $3, 'success', $4, now() + ${AUDIT_RETENTION})`, [owner.clientId, action, requestId, traceId]);
  }
}
