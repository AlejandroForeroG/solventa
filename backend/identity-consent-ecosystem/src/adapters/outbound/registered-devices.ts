import { Client } from 'pg';
import type { DeviceCapture, DeviceOperation, DeviceStore, RegisteredDevice } from '../../application/registered-devices';

export class SqlRegisteredDevices implements DeviceStore {
  constructor(private readonly connectionString: string) {}

  async execute(input: DeviceOperation, decide: Parameters<DeviceStore['execute']>[1]): Promise<RegisteredDevice | null> {
    const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1000, query_timeout: 1500 });
    db.on('error', () => {});
    try {
      await db.connect();
      await db.query('BEGIN');
      // Lock the session shared with logout before evaluating or persisting any device decision.
      const session = (await db.query<{ id: string; client_id: string; subject_token: string; client_status: string; created_at: Date; expires_at: Date; revoked_at: Date | null; observed_at: Date }>(`
        SELECT s.id,s.client_id,c.subject_token,c.status AS client_status,s.created_at,s.expires_at,s.revoked_at,now() AS observed_at
        FROM identity.authentication_sessions s JOIN identity.clients c ON c.id=s.client_id
        JOIN identity.external_identities e ON e.client_id=c.id AND e.provider='workos'
        WHERE s.provider='workos' AND s.provider_session=$1 AND e.provider_subject=$2 FOR UPDATE OF s`,
      [input.identity.sessionReference, input.identity.providerSubject])).rows[0];
      const prefix = `mobile-v1:${input.identity.sessionReference}:`;
      const existing = session ? (await db.query<{ id: string; revoked_at: Date | null; device_reference: string }>(`
        SELECT id,revoked_at,device_reference FROM identity.registered_devices
        WHERE client_id=$1 AND split_part(device_reference,':',1)='mobile-v1'
        AND split_part(device_reference,':',2)=$2 FOR UPDATE`, [session.client_id, input.identity.sessionReference])).rows : [];
      const observedAt = session ? session.observed_at.getTime() : Date.now();
      const { decision, capture } = decide({ observedAt,
        session: session ? { clientActive: session.client_status === 'active', createdAt: session.created_at.getTime(), expiresAt: session.expires_at.getTime(), revoked: session.revoked_at !== null } : null,
        bindings: existing.map(row => ({ id: row.id, installationId: row.device_reference.slice(prefix.length), revoked: row.revoked_at !== null })),
      });
      let result: RegisteredDevice | null = null;
      if (session) {
        if (decision.effect === 'register') {
          const id = crypto.randomUUID();
          await db.query('INSERT INTO identity.registered_devices (id,client_id,device_reference) VALUES ($1,$2,$3)', [id, session.client_id, prefix + input.installationId]);
          await this.audit(db, input, session.subject_token, id, 'registered', capture);
          result = { id, installationId: input.installationId, status: 'active' };
        } else if (decision.effect === 'revoke') {
          await db.query('UPDATE identity.registered_devices SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [decision.device.id]);
          await db.query('UPDATE identity.authentication_sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [session.id]);
          await this.audit(db, input, session.subject_token, decision.device.id, 'revoked', capture);
          result = decision.device;
        } else if (decision.effect === 'none') {
          result = decision.device;
        } else if (decision.record) {
          await this.audit(db, input, session.subject_token, crypto.randomUUID(), 'registration_denied', capture);
        }
      }
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      // Never retry an uncertain commit. An explicit registration retry re-evaluates the locked state.
      throw error;
    } finally { await db.end().catch(() => {}); }
  }

  private async audit(db: Client, input: DeviceOperation, actor: string, id: string, action: 'registered' | 'revoked' | 'registration_denied', capture: DeviceCapture) {
    const denied = action === 'registration_denied';
    const resource = denied ? 'device_registration' : 'registered_device';
    await db.query(`INSERT INTO identity.audit_events
      (actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
      VALUES ($1,$2,$3,$4,$5,$6,now()+INTERVAL '90 days')`,
    [actor, `device.${action}`, resource, id, denied ? capture.outcome : 'success', input.correlationId]);
    await db.query(`INSERT INTO identity.outbox_events
      (event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id)
      VALUES ($1,$2,$3,$4,1,$5,$6)`, [crypto.randomUUID(), resource, id, `identity.device_${action}`,
    JSON.stringify({ ...(denied ? { decisionId: id } : { deviceId: id }), action, sessionBound: true, capture }), input.correlationId]);
  }
}
