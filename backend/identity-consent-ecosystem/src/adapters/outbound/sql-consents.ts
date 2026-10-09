import { Client } from 'pg';
import type { Principal } from '../../application/authentication';
import { safeCode } from '../safe-code';
import type { ConsentStore, GrantResult, NewConsent, RevokeResult } from '../../application/ports/consents';
import type { Consent, Locale, ScopeCode, SourceCode } from '../../domain/consent';

const RETENTION = '5 years'; // Provisional audit retention until the policy owner defines it.
const SERIALIZATION_FAILURE = '40001';

type Row = {
  id: string; consent_code: string; version: string; client_id: string; purpose: string; text_version: string;
  locale: Locale; wording_hash: string; sources: SourceCode[]; scopes: ScopeCode[]; granted_at: Date; expires_at: Date; revoked_at: Date | null;
  quote_ref: string | null; seal: string; request_hash?: string;
};
const COLUMNS = ['id', 'consent_code', 'version', 'client_id', 'purpose', 'text_version', 'locale', 'wording_hash', 'sources', 'scopes', 'granted_at', 'expires_at', 'revoked_at', 'quote_ref', 'seal', 'request_hash'];
const plain = COLUMNS.join(', ');
const prefixed = COLUMNS.map(column => `c.${column}`).join(', ');
const fromRow = (row: Row): Consent => ({
  id: row.id, consentCode: row.consent_code, version: Number(row.version), clientId: row.client_id, purposeCode: row.purpose,
  textVersion: Number(row.text_version), locale: row.locale, wordingHash: row.wording_hash, sources: row.sources, scopes: row.scopes, grantedAt: row.granted_at, expiresAt: row.expires_at,
  revokedAt: row.revoked_at, quoteRef: row.quote_ref, seal: row.seal
});

export class SqlConsents implements ConsentStore {
  constructor(private readonly connectionString: string) {}

  private async connect() {
    const client = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 3000, query_timeout: 3000 });
    client.on('error', () => {});
    await client.connect();
    return client;
  }

  private async retrying<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await operation(); }
      catch (error) {
        if ((error as { code?: string }).code !== SERIALIZATION_FAILURE || attempt >= 3) throw error;
      }
    }
  }

  grant(consent: NewConsent): Promise<GrantResult> {
    return this.retrying(() => this.grantOnce(consent));
  }

  private async grantOnce(c: NewConsent): Promise<GrantResult> {
    const client = await this.connect();
    try {
      const found = await this.findByKey(client, c);
      if (found) return found;

      // Allocated before the transaction: inside it the counter row stays locked until COMMIT and
      // serializes every grant. A failed transaction leaves a gap in the numbering, never a repeat.
      const counter = await client.query<{ last_value: string }>(
        'INSERT INTO identity.consent_counters (year, last_value) VALUES ($1, 1) ON CONFLICT (year) DO UPDATE SET last_value = identity.consent_counters.last_value + 1 RETURNING last_value', [c.year]);
      const code = `CNS-${c.year}-${String(counter.rows[0].last_value).padStart(5, '0')}`;
      await client.query('BEGIN');
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO identity.consents (id, version, client_id, purpose, scopes, source, granted_at, expires_at, correlation_id, consent_code, text_version, sources, quote_ref, seal, idempotency_key, request_hash, locale, wording_hash)
         VALUES ($1, $2, $3, $4, $5, 'web', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT DO NOTHING RETURNING id`,
        [c.id, c.version, c.clientId, c.purposeCode, c.scopes, c.grantedAt, c.expiresAt, c.traceId, code, c.textVersion, c.sources, c.quoteRef, c.seal, c.idempotencyKey, c.requestHash, c.locale, c.wordingHash]);
      if (!inserted.rows[0]) {
        // A concurrent retry won the race: discard our work and answer from its row.
        await client.query('ROLLBACK');
        const winner = await this.findByKey(client, c);
        if (winner) return winner;
        throw Object.assign(new Error('consent_race_unresolved'), { code: SERIALIZATION_FAILURE });
      }
      await this.audit(client, c.subjectToken, 'consent.granted', 'consent', c.id, c.traceId);
      await this.outbox(client, c.id, 'consent.granted', { consentId: code, version: c.version, textVersion: c.textVersion }, c.traceId);
      await client.query('COMMIT');
      return { kind: 'created', consent: { ...c, consentCode: code, revokedAt: null } };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await client.end().catch(() => {});
    }
  }

  private async findByKey(client: Client, c: NewConsent): Promise<GrantResult | null> {
    const existing = await client.query<Row>(`SELECT ${plain} FROM identity.consents WHERE client_id = $1 AND idempotency_key = $2`, [c.clientId, c.idempotencyKey]);
    const row = existing.rows[0];
    if (!row) return null;
    return row.request_hash === c.requestHash ? { kind: 'replayed', consent: fromRow(row) } : { kind: 'conflict' };
  }

  async list(principal: Principal, limit: number, now: Date): Promise<Consent[]> {
    const client = await this.connect();
    try {
      const result = await client.query<Row>(
        `SELECT ${plain} FROM identity.consents WHERE client_id = $1 AND consent_code IS NOT NULL ORDER BY granted_at DESC, id LIMIT $2`, [principal.clientId, limit]);
      await this.auditExpired(client, principal.subjectToken, result.rows, now);
      return result.rows.map(fromRow);
    } finally {
      await client.end().catch(() => {});
    }
  }

  revoke(principal: Principal, consentCode: string, now: Date, traceId: string): Promise<RevokeResult> {
    return this.retrying(() => this.revokeOnce(principal, consentCode, now, traceId));
  }

  private async revokeOnce(principal: Principal, consentCode: string, now: Date, traceId: string): Promise<RevokeResult> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query<Row>(
        `UPDATE identity.consents SET revoked_at = $3 WHERE client_id = $1 AND consent_code = $2 AND revoked_at IS NULL AND expires_at > $3 RETURNING ${plain}`,
        [principal.clientId, consentCode, now]);
      const row = updated.rows[0];
      if (row) {
        await this.audit(client, principal.subjectToken, 'consent.revoked', 'consent', row.id, traceId);
        await this.outbox(client, row.id, 'consent.revoked', { consentId: row.consent_code, version: Number(row.version) }, traceId);
        await client.query('COMMIT');
        return { kind: 'revoked', consent: fromRow(row) };
      }
      await client.query('ROLLBACK');
      const current = await client.query<Row>(`SELECT ${plain} FROM identity.consents WHERE client_id = $1 AND consent_code = $2`, [principal.clientId, consentCode]);
      const existing = current.rows[0];
      if (!existing) return { kind: 'not_found' };
      return existing.revoked_at ? { kind: 'already_revoked', consent: fromRow(existing) } : { kind: 'not_active', consent: fromRow(existing) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await client.end().catch(() => {});
    }
  }

  async decline(principal: Principal, traceId: string): Promise<void> {
    const client = await this.connect();
    try {
      // There is no consent to point at, so the audit event refers to the request itself.
      await this.audit(client, principal.subjectToken, 'consent.declined', 'consent_request', traceId, traceId);
    } finally {
      await client.end().catch(() => {});
    }
  }

  async forSubject(subjectToken: string, purposeCode: string, scope: string, now: Date): Promise<Consent[]> {
    const client = await this.connect();
    try {
      const of = `FROM identity.consents c JOIN identity.clients owner ON owner.id = c.client_id
         WHERE owner.subject_token = $1 AND owner.status = 'active' AND c.purpose = $2 AND $3::STRING = ANY(c.scopes) AND c.consent_code IS NOT NULL`;
      const parameters = [subjectToken, purposeCode, scope];
      // Only usable consents are searched, so newer revoked or expired ones never hide an active one; without
      // any, the latest record is read just to explain the denial.
      const usable = await client.query<Row>(
        `SELECT ${prefixed} ${of} AND c.revoked_at IS NULL AND c.expires_at > $4 ORDER BY c.granted_at DESC, c.id LIMIT 20`, [...parameters, now]);
      const rows = usable.rows.length ? usable.rows
        : (await client.query<Row>(`SELECT ${prefixed} ${of} ORDER BY c.granted_at DESC, c.id LIMIT 1`, parameters)).rows;
      await this.auditExpired(client, subjectToken, rows, now);
      return rows.map(fromRow);
    } finally {
      await client.end().catch(() => {});
    }
  }

  private async audit(client: Client, actor: string, action: string, resourceType: string, resourceId: string, traceId: string) {
    await client.query(
      `INSERT INTO identity.audit_events (actor_reference, action, resource_type, resource_id, outcome, correlation_id, retention_until)
       VALUES ($1, $2, $3, $4, 'success', $5, now() + interval '${RETENTION}')`, [actor, action, resourceType, resourceId, traceId]);
  }

  private async outbox(client: Client, aggregateId: string, eventType: string, payload: object, traceId: string) {
    await client.query(
      `INSERT INTO identity.outbox_events (event_id, aggregate_type, aggregate_id, event_type, event_version, payload, correlation_id)
       VALUES (gen_random_uuid(), 'consent', $1, $2, 1, $3, $4)`, [aggregateId, eventType, JSON.stringify(payload), traceId]);
  }

  // Expiry has no moment of its own, so it is recorded once, the first time a read finds it. The consent
  // answer never depends on this write: a failure is logged and the next read tries again.
  private async auditExpired(client: Client, actor: string, rows: Row[], now: Date) {
    for (const row of rows.filter(r => !r.revoked_at && r.expires_at.getTime() <= now.getTime())) {
      await client.query(
        `INSERT INTO identity.audit_events (actor_reference, action, resource_type, resource_id, outcome, correlation_id, retention_until)
         SELECT $1, 'consent.expired', 'consent', $2, 'success', gen_random_uuid(), now() + interval '${RETENTION}'
         WHERE NOT EXISTS (SELECT 1 FROM identity.audit_events WHERE resource_type = 'consent' AND resource_id = $2 AND action = 'consent.expired')`,
        [actor, row.id]).catch(error => console.error(JSON.stringify({ event: 'consent_expiry_audit_failed', code: safeCode(error) })));
    }
  }
}
