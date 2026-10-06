import { Client } from 'pg';
import type { IdentitySessions, Principal, VerifiedIdentity } from '../../application/authentication';

export class SqlIdentitySessions implements IdentitySessions {
  constructor(private readonly connectionString: string) {}
  private async transaction<T>(operation: (db: Client) => Promise<T>): Promise<T> {
    const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 3000, query_timeout: 5000 });
    db.on('error', () => {});
    try {
      await db.connect();
      await db.query('BEGIN');
      const result = await operation(db);
      await db.query('COMMIT');
      return result;
    } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
    finally { await db.end().catch(() => {}); }
  }
  async open(identity: VerifiedIdentity): Promise<Principal> {
    return this.transaction(async db => {
      let row = (await db.query(`SELECT c.id, c.subject_token, c.status FROM identity.external_identities e
        JOIN identity.clients c ON c.id=e.client_id WHERE e.provider='workos' AND e.provider_subject=$1`, [identity.providerSubject])).rows[0];
      const correlation = crypto.randomUUID();
      if (!row) {
        const id = crypto.randomUUID();
        const subject = crypto.randomUUID();
        row = (await db.query('INSERT INTO identity.clients (id,subject_token) VALUES ($1,$2) RETURNING id,subject_token,status', [id, subject])).rows[0];
        // A concurrent first login loses the unique constraint and rolls back;
        // it never publishes a second client or returns a partial success.
        await db.query("INSERT INTO identity.external_identities (client_id,provider,provider_subject) VALUES ($1,'workos',$2)", [id, identity.providerSubject]);
        await db.query(`INSERT INTO identity.outbox_events (event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id)
          VALUES ($1,'client',$2,'identity.client_created',1,$3,$4)`, [crypto.randomUUID(), id, JSON.stringify({ clientId: id, subjectToken: subject }), correlation]);
      }
      if (row.status !== 'active') throw new Error('client_inactive');
      const session = (await db.query(`INSERT INTO identity.authentication_sessions (client_id,provider,provider_session)
        VALUES ($1,'workos',$2) ON CONFLICT (provider,provider_session) DO NOTHING RETURNING id`, [row.id, identity.sessionReference])).rows[0];
      if (!session) throw new Error('session_already_registered');
      await db.query(`INSERT INTO identity.audit_events (actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
        VALUES ($1,'session.opened','authentication_session',$2,'success',$3,now()+INTERVAL '90 days')`, [row.subject_token, session.id, correlation]);
      return { clientId: row.id, subjectToken: row.subject_token };
    });
  }
  async find(identity: VerifiedIdentity): Promise<Principal | null> {
    return this.transaction(async db => {
      const row = (await db.query(`SELECT c.id, c.subject_token FROM identity.authentication_sessions s
        JOIN identity.clients c ON c.id=s.client_id JOIN identity.external_identities e ON e.client_id=c.id
        WHERE s.provider='workos' AND s.provider_session=$1 AND e.provider='workos' AND e.provider_subject=$2
        AND c.status='active' AND s.revoked_at IS NULL AND s.expires_at>now()`, [identity.sessionReference, identity.providerSubject])).rows[0];
      return row ? { clientId: row.id, subjectToken: row.subject_token } : null;
    });
  }
  async revoke(identity: VerifiedIdentity): Promise<void> {
    await this.transaction(async db => {
      const row = (await db.query(`UPDATE identity.authentication_sessions s SET revoked_at=now()
        FROM identity.external_identities e WHERE e.client_id=s.client_id AND e.provider='workos' AND e.provider_subject=$1
        AND s.provider='workos' AND s.provider_session=$2 AND s.revoked_at IS NULL RETURNING s.id,s.client_id`, [identity.providerSubject, identity.sessionReference])).rows[0];
      const actor = row ? (await db.query('SELECT subject_token FROM identity.clients WHERE id=$1', [row.client_id])).rows[0].subject_token : null;
      if (row) await db.query(`INSERT INTO identity.audit_events (actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
        VALUES ($1,'session.revoked','authentication_session',$2,'success',$3,now()+INTERVAL '90 days')`, [actor, row.id, crypto.randomUUID()]);
    });
  }
}
