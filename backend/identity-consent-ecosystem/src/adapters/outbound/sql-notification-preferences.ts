import { Client } from 'pg';
import type { NotificationPreferenceStore, NotificationPreferencesView } from '../../application/notification-preferences';
import { notificationMatrix, NotificationPreferenceFailure } from '../../domain/notification-preferences';
import type { VerifiedIdentity } from '../../application/authentication';

type Row = { version: string; preferences: unknown };
type CommandRow = { request_hash: string; result_version: string; result_preferences: unknown };

export class SqlNotificationPreferences implements NotificationPreferenceStore {
  constructor(private readonly connectionString: string) {}
  private async connection<T>(run: (db: Client) => Promise<T>): Promise<T> {
    const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1500,
      query_timeout: 3000, statement_timeout: 2800 });
    db.on('error', () => {});
    try { await db.connect(); return await run(db); }
    finally { await db.end().catch(() => {}); }
  }
  async read(clientId: string, identity: VerifiedIdentity): Promise<NotificationPreferencesView | null> {
    return this.connection(async db => {
      const access = (await db.query<{ id: string }>(`SELECT c.id FROM identity.authentication_sessions s
        JOIN identity.clients c ON c.id=s.client_id JOIN identity.external_identities e
        ON e.client_id=c.id AND e.provider='workos' WHERE c.id=$1 AND c.status='active'
        AND s.provider='workos' AND s.provider_session=$2 AND e.provider_subject=$3
        AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()`,
      [clientId, identity.sessionReference, identity.providerSubject])).rows[0];
      if (!access) throw new NotificationPreferenceFailure('unauthorized', 401);
      const row = (await db.query<Row>(`SELECT version,preferences FROM identity.notification_preferences
        WHERE client_id=$1`, [clientId])).rows[0];
      if (!row) return null;
      if (!notificationMatrix(row.preferences)) throw new Error('notification_preferences_invalid');
      return { version: Number(row.version), preferences: row.preferences };
    });
  }
  async save(input: { clientId: string; actor: string; preferences: NotificationPreferencesView['preferences'];
    expectedVersion: number; key: string; requestHash: string; traceId: string; identity: VerifiedIdentity }): Promise<NotificationPreferencesView> {
    return this.connection(async db => {
      await db.query('BEGIN');
      try {
        // Serializing on the owner also covers the first preference write.
        const owner = (await db.query<{ id: string }>(`SELECT c.id FROM identity.authentication_sessions s
          JOIN identity.clients c ON c.id=s.client_id JOIN identity.external_identities e
          ON e.client_id=c.id AND e.provider='workos' WHERE c.id=$1 AND c.status='active'
          AND s.provider='workos' AND s.provider_session=$2 AND e.provider_subject=$3
          AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR UPDATE OF s,c`,
        [input.clientId, input.identity.sessionReference, input.identity.providerSubject])).rows[0];
        if (!owner) throw new NotificationPreferenceFailure('unauthorized', 401);
        const previous = (await db.query<CommandRow>(`SELECT request_hash,result_version,result_preferences
          FROM identity.notification_preference_commands WHERE client_id=$1 AND idempotency_key=$2`,
        [input.clientId, input.key])).rows[0];
        if (previous) {
          if (previous.request_hash !== input.requestHash || !notificationMatrix(previous.result_preferences))
            throw new NotificationPreferenceFailure('conflict', 409);
          await db.query('COMMIT');
          return { version: Number(previous.result_version), preferences: previous.result_preferences };
        }
        const existing = (await db.query<Row>(`SELECT version,preferences FROM identity.notification_preferences WHERE client_id=$1 FOR UPDATE`,
          [input.clientId])).rows[0];
        if (existing && !notificationMatrix(existing.preferences)) throw new Error('notification_preferences_invalid');
        const version = existing ? Number(existing.version) : 0;
        if (version !== input.expectedVersion) throw new NotificationPreferenceFailure('conflict', 409);
        const next = version + 1;
        const data = JSON.stringify(input.preferences);
        await db.query(`INSERT INTO identity.notification_preferences (client_id,version,preferences) VALUES ($1,$2,$3)
          ON CONFLICT (client_id) DO UPDATE SET version=excluded.version,preferences=excluded.preferences,updated_at=now()`,
        [input.clientId, next, data]);
        await db.query(`INSERT INTO identity.notification_preference_commands
          (client_id,idempotency_key,request_hash,result_version,result_preferences) VALUES ($1,$2,$3,$4,$5)`,
        [input.clientId, input.key, input.requestHash, next, data]);
        await db.query(`INSERT INTO identity.audit_events
          (actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
          VALUES ($1,'notification_preferences.updated','notification_preferences',$2,'success',$3,now()+INTERVAL '2 years')`,
        [input.actor, input.clientId, input.traceId]);
        await db.query(`INSERT INTO identity.outbox_events
          (event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id)
          VALUES ($1,'notification_preferences',$2,'identity.notification_preferences_updated',1,$3,$4)`,
        [crypto.randomUUID(), input.clientId, JSON.stringify({ schemaVersion: 1, clientId: input.clientId,
          version: next, preferences: input.preferences, capture: { schemaVersion: 1, contractVersion: 'v1',
            correlationId: input.traceId, inputs: { expectedVersion: input.expectedVersion, preferences: input.preferences },
            sources: [], consent: { status: 'not_required' }, rule: { id: 'notification-preferences-replace', version: '1' },
            outcome: 'saved' } }), input.traceId]);
        await db.query('COMMIT');
        return { version: next, preferences: input.preferences };
      } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
    });
  }
}
