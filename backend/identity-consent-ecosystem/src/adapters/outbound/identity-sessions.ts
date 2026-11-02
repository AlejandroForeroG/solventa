import { Client } from 'pg';
import type { IdentitySessions, Principal, VerifiedIdentity } from '../../application/authentication';
import { canonicalInstallationId, deviceLogoutPolicy } from '../../domain/registered-device';

type StoredClient = { id: string; subject_token: string; status: string };
type RevocationSession = { id: string; client_id: string; subject_token: string; revoked_at: Date | null };
export type SharedIdentityConnection = { get(): Promise<Client>; close(): Promise<void> };

export class SqlIdentitySessions implements IdentitySessions {
  constructor(private readonly connectionString: string, private readonly shared?: SharedIdentityConnection) {}
  static async sharedConnection(connectionString: string) {
    let client: Client | undefined;
    let connecting: Promise<Client> | undefined;
    return {
      get: async () => {
        if (client) return client;
        if (!connecting) {
          const next = new Client({ connectionString, connectionTimeoutMillis: 3000, query_timeout: 5000 });
          next.on('error', () => {});
          connecting = next.connect().then(() => { client = next; return next; });
        }
        return connecting;
      },
      close: async () => {
        const active = client ?? await connecting?.catch(() => undefined);
        client = undefined;
        connecting = undefined;
        await active?.end().catch(() => {});
      },
    };
  }
  private async connection<T>(operation: (db: Client) => Promise<T>): Promise<T> {
    if (this.shared) return operation(await this.shared.get());
    const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 3000, query_timeout: 5000 });
    db.on('error', () => {});
    try { await db.connect(); return await operation(db); }
    finally { await db.end().catch(() => {}); }
  }
  private async transaction<T>(operation: (db: Client) => Promise<T>): Promise<T> {
    const db = this.shared ? await this.shared.get() : new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 3000, query_timeout: 5000 });
    db.on('error', () => {});
    try {
      if (!this.shared) await db.connect();
      await db.query('BEGIN');
      const result = await operation(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      let rolledBack = false;
      await db.query('ROLLBACK').then(() => { rolledBack = true; }).catch(() => {});
      if (rolledBack && error && typeof error === 'object' && 'code' in error && ['40001', '23505'].includes(String(error.code))) {
        throw new Error('session_transaction_retry', { cause: error });
      }
      throw error;
    }
    finally { if (!this.shared) await db.end().catch(() => {}); }
  }
  private async ensureClient(db: Client, identity: VerifiedIdentity, correlation: string): Promise<StoredClient> {
      let row = (await db.query<StoredClient>(`SELECT c.id, c.subject_token, c.status FROM identity.external_identities e
        JOIN identity.clients c ON c.id=e.client_id WHERE e.provider='workos' AND e.provider_subject=$1`, [identity.providerSubject])).rows[0];
      if (!row) {
        const id = crypto.randomUUID();
        const subject = crypto.randomUUID();
        row = (await db.query<StoredClient>('INSERT INTO identity.clients (id,subject_token) VALUES ($1,$2) RETURNING id,subject_token,status', [id, subject])).rows[0];
        // A concurrent first login loses the unique constraint and rolls back;
        // it never publishes a second client or returns a partial success.
        await db.query("INSERT INTO identity.external_identities (client_id,provider,provider_subject) VALUES ($1,'workos',$2)", [id, identity.providerSubject]);
        await db.query(`INSERT INTO identity.outbox_events (event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id)
          VALUES ($1,'client',$2,'identity.client_created',1,$3,$4)`, [crypto.randomUUID(), id, JSON.stringify({ clientId: id, subjectToken: subject }), correlation]);
      }
      return row;
  }
  async open(identity: VerifiedIdentity): Promise<Principal> {
    return this.transaction(async db => {
      const correlation = crypto.randomUUID();
      const row = await this.ensureClient(db, identity, correlation);
      if (row.status !== 'active') throw new Error('client_inactive');
      const session = (await db.query(`INSERT INTO identity.authentication_sessions (client_id,provider,provider_session)
        VALUES ($1,'workos',$2) ON CONFLICT (provider,provider_session) DO NOTHING RETURNING id`, [row.id, identity.sessionReference])).rows[0];
      if (!session) throw new Error('session_already_registered');
      await db.query(`INSERT INTO identity.audit_events (actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
        VALUES ($1,'session.opened','authentication_session',$2,'success',$3,now()+INTERVAL '90 days')`, [row.subject_token, session.id, correlation]);
      return { clientId: row.id, subjectToken: row.subject_token };
    });
  }
  async revokeOrBlock(identity: VerifiedIdentity, correlation: string): Promise<void> {
    correlation = correlation.toLowerCase();
    const operation = async (db: Client) => {
      const existing = (await db.query<RevocationSession & { provider_subject: string }>(`SELECT s.id, s.client_id, s.revoked_at, c.subject_token, e.provider_subject
        FROM identity.authentication_sessions s JOIN identity.clients c ON c.id=s.client_id
        JOIN identity.external_identities e ON e.client_id=c.id AND e.provider='workos'
        WHERE s.provider='workos' AND s.provider_session=$1 FOR UPDATE OF s`, [identity.sessionReference])).rows[0];
      let sessionId: string;
      let actor: string;
      let clientId: string;
      if (existing) {
        if (existing.provider_subject !== identity.providerSubject) throw new Error('session_owner_mismatch');
        if (existing.revoked_at !== null) {
          await this.revokeDevices(db, identity, existing.client_id, existing.subject_token, correlation);
          return;
        }
        const updated = (await db.query(`UPDATE identity.authentication_sessions SET revoked_at=now()
          WHERE id=$1 AND revoked_at IS NULL RETURNING id`, [existing.id])).rows[0];
        if (!updated) {
          await this.revokeDevices(db, identity, existing.client_id, existing.subject_token, correlation);
          return;
        }
        sessionId = updated.id;
        actor = existing.subject_token;
        clientId = existing.client_id;
      } else {
        const client = await this.ensureClient(db, identity, correlation);
        // The blocking reference is born revoked; no active session is ever committed by logout.
        const blocked = (await db.query(`INSERT INTO identity.authentication_sessions
          (client_id,provider,provider_session,revoked_at) VALUES ($1,'workos',$2,now()) RETURNING id`,
          [client.id, identity.sessionReference])).rows[0];
        sessionId = blocked.id;
        actor = client.subject_token;
        clientId = client.id;
      }
      await db.query(`INSERT INTO identity.audit_events (actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
        VALUES ($1,'session.revoked','authentication_session',$2,'success',$3,now()+INTERVAL '90 days')`, [actor, sessionId, correlation]);
      await this.revokeDevices(db, identity, clientId, actor, correlation);
    };
    try { await this.transaction(operation); }
    catch (error) {
      if (!(error instanceof Error && error.message === 'session_transaction_retry')) throw error;
      await this.transaction(operation);
    }
  }
  private async revokeDevices(db: Client, identity: VerifiedIdentity, clientId: string, actor: string, correlation: string): Promise<void> {
      const devices = (await db.query<{ id: string; device_reference: string }>(`UPDATE identity.registered_devices SET revoked_at=now()
        WHERE split_part(device_reference,':',1)='mobile-v1' AND split_part(device_reference,':',2)=$1
        AND client_id=$2 AND revoked_at IS NULL RETURNING id,device_reference`, [identity.sessionReference, clientId])).rows;
      for (const device of devices) {
        await db.query(`INSERT INTO identity.audit_events (actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
          VALUES ($1,'device.revoked','registered_device',$2,'success',$3,now()+INTERVAL '90 days')`, [actor, device.id, correlation]);
        await db.query(`INSERT INTO identity.outbox_events (event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id)
          VALUES ($1,'registered_device',$2,'identity.device_revoked',1,$3,$4)`,
        [crypto.randomUUID(), device.id, JSON.stringify({ deviceId: device.id, action: 'revoked', sessionBound: true,
          capture: {
            schemaVersion: 1, contractVersion: 'v1', correlationId: correlation,
            inputs: { action: 'revoke', installationId: canonicalInstallationId(device.device_reference.split(':')[2]), sessionBound: true },
            sources: [{ source: 'verified-session', capturedAt: new Date().toISOString(), quality: 'verified' }],
            consent: { status: 'not_required' }, rule: { ...deviceLogoutPolicy }, outcome: 'revoke',
          },
        }), correlation]);
      }
  }
  async find(identity: VerifiedIdentity): Promise<Principal | null> {
    return this.connection(async db => {
      const row = (await db.query(`SELECT c.id, c.subject_token FROM identity.authentication_sessions s
        JOIN identity.clients c ON c.id=s.client_id JOIN identity.external_identities e ON e.client_id=c.id
        WHERE s.provider='workos' AND s.provider_session=$1 AND e.provider='workos' AND e.provider_subject=$2
        AND c.status='active' AND s.revoked_at IS NULL AND s.expires_at>now()`, [identity.sessionReference, identity.providerSubject])).rows[0];
      return row ? { clientId: row.id, subjectToken: row.subject_token } : null;
    });
  }
  async register(identity: VerifiedIdentity): Promise<Principal | null> {
    const active = await this.find(identity);
    if (active) return active;
    try { return await this.open(identity); }
    catch (error) {
      // A replay never updates expiry or clears revocation; the original session wins.
      if (error instanceof Error && ['session_already_registered', 'client_inactive'].includes(error.message)) return this.find(identity);
      // Retry a known rejected transaction once, never an uncertain commit.
      if ((error instanceof Error && error.message === 'session_transaction_retry')
        || (error && typeof error === 'object' && 'code' in error && error.code === '23505')) {
        const principal = await this.find(identity);
        if (principal) return principal;
        try { return await this.open(identity); }
        catch (retryError) {
          if (retryError instanceof Error && ['session_already_registered', 'client_inactive'].includes(retryError.message)) return this.find(identity);
          throw retryError;
        }
      }
      throw error;
    }
  }
  async revoke(identity: VerifiedIdentity, correlation = crypto.randomUUID()): Promise<void> {
    correlation = correlation.toLowerCase();
    await this.transaction(async db => {
      const row = (await db.query<RevocationSession>(`SELECT s.id,s.client_id,s.revoked_at,c.subject_token
        FROM identity.authentication_sessions s JOIN identity.clients c ON c.id=s.client_id
        JOIN identity.external_identities e ON e.client_id=s.client_id AND e.provider='workos'
        WHERE e.provider_subject=$1 AND s.provider='workos' AND s.provider_session=$2 FOR UPDATE OF s`, [identity.providerSubject, identity.sessionReference])).rows[0];
      if (!row) return;
      if (row.revoked_at === null) {
        await db.query('UPDATE identity.authentication_sessions SET revoked_at=now() WHERE id=$1', [row.id]);
        await db.query(`INSERT INTO identity.audit_events (actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
          VALUES ($1,'session.revoked','authentication_session',$2,'success',$3,now()+INTERVAL '90 days')`, [row.subject_token, row.id, correlation]);
      }
      await this.revokeDevices(db, identity, row.client_id, row.subject_token, correlation);
    });
  }
}
