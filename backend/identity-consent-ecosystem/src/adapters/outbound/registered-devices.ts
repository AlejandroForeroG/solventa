import { Client } from 'pg';
import type { DeviceOperation, DeviceStore, RegisteredDevice } from '../../application/registered-devices';

export class SqlRegisteredDevices implements DeviceStore {
  constructor(private readonly connectionString: string) {}

  private async execute(action: 'register' | 'find' | 'revoke', input: DeviceOperation): Promise<RegisteredDevice | null> {
    const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1000, query_timeout: 1500 });
    db.on('error', () => {});
    try {
      await db.connect();
      await db.query('BEGIN');
      // Lock the session shared with logout. A device cannot be activated after revocation commits.
      const session = (await db.query<{ id: string; client_id: string; subject_token: string; fresh: boolean }>(`
        SELECT s.id,s.client_id,c.subject_token,s.created_at>now()-INTERVAL '10 minutes' AS fresh
        FROM identity.authentication_sessions s JOIN identity.clients c ON c.id=s.client_id
        JOIN identity.external_identities e ON e.client_id=c.id AND e.provider='workos'
        WHERE s.provider='workos' AND s.provider_session=$1 AND e.provider_subject=$2
        AND c.status='active' AND ($3 OR (s.revoked_at IS NULL AND s.expires_at>now())) FOR UPDATE OF s`,
      [input.identity.sessionReference, input.identity.providerSubject, action === 'revoke'])).rows[0];
      let result: RegisteredDevice | null = null;
      if (session) {
        const prefix = `mobile-v1:${input.identity.sessionReference}:`;
        const reference = prefix + input.installationId;
        const existing = (await db.query<{ id: string; revoked_at: string | null; device_reference: string }>(`
          SELECT id,revoked_at,device_reference FROM identity.registered_devices
          WHERE client_id=$1 AND split_part(device_reference,':',1)='mobile-v1'
          AND split_part(device_reference,':',2)=$2 FOR UPDATE`, [session.client_id, input.identity.sessionReference])).rows;
        const device = existing.find(row => row.device_reference === reference);
        if (action === 'register' && !device && existing.length === 0 && session.fresh) {
          const id = crypto.randomUUID();
          await db.query('INSERT INTO identity.registered_devices (id,client_id,device_reference) VALUES ($1,$2,$3)', [id, session.client_id, reference]);
          await this.audit(db, input, session.subject_token, id, 'registered');
          result = { id, installationId: input.installationId, status: 'active' };
        } else if (device && (device.revoked_at === null || action === 'revoke')) {
          if (action === 'revoke' && device.revoked_at === null) {
            await db.query('UPDATE identity.registered_devices SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [device.id]);
            // Revoking the binding also blocks use of its still-signed bearer token.
            await db.query('UPDATE identity.authentication_sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [session.id]);
            await this.audit(db, input, session.subject_token, device.id, 'revoked');
          }
          result = { id: device.id, installationId: input.installationId, status: action === 'revoke' ? 'revoked' : 'active' };
        }
      }
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      // Never retry an uncertain commit. Registration is replay-safe on an explicit retry.
      throw error;
    } finally { await db.end().catch(() => {}); }
  }

  private async audit(db: Client, input: DeviceOperation, actor: string, id: string, action: 'registered' | 'revoked') {
    await db.query(`INSERT INTO identity.audit_events
      (actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
      VALUES ($1,$2,'registered_device',$3,'success',$4,now()+INTERVAL '90 days')`,
    [actor, `device.${action}`, id, input.correlationId]);
    await db.query(`INSERT INTO identity.outbox_events
      (event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id)
      VALUES ($1,'registered_device',$2,$3,1,$4,$5)`, [crypto.randomUUID(), id, `identity.device_${action}`,
    JSON.stringify({ deviceId: id, action, sessionBound: true, capture: input.capture }), input.correlationId]);
  }

  register = (input: DeviceOperation) => this.execute('register', input);
  find = (input: DeviceOperation) => this.execute('find', input);
  revoke = (input: DeviceOperation) => this.execute('revoke', input);
}
