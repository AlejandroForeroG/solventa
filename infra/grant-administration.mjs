import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const fail = code => Object.assign(new Error(code), { code });

// Administrative operation only: the deployed Identity runtime has SELECT on grant tables.
// The operator reference is traceability, not authentication; SQL privileges enforce administration.
// `table` and `resourceType` are constants chosen by the caller module, never user input.
export function createGrantAdministration({ table, operations, resourceType, failureCode }) {
  function validate(environment, action, input, now = Date.now()) {
    if (!['local', 'dev', 'staging', 'prod'].includes(environment) || !['grant', 'revoke'].includes(action)) throw fail('invalid_command');
    const keys = action === 'grant' ? ['grantId', 'clientId', 'operation', 'expiresAt', 'operatorReference'] : ['grantId', 'operatorReference'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))
      || !uuid(input.grantId) || !uuid(input.operatorReference)) throw fail('invalid_input');
    if (action === 'grant' && (!uuid(input.clientId) || !operations.includes(input.operation) || typeof input.expiresAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.expiresAt) || !Number.isFinite(Date.parse(input.expiresAt))
      || new Date(input.expiresAt).toISOString() !== input.expiresAt || Date.parse(input.expiresAt) <= now || Date.parse(input.expiresAt) > now + 90 * 86400000)) throw fail('invalid_expiry');
    const canonical = { ...input, grantId: input.grantId.toLowerCase(), operatorReference: input.operatorReference.toLowerCase() };
    if (action === 'grant') canonical.clientId = input.clientId.toLowerCase();
    return canonical;
  }

  async function change(db, environment, action, input) {
    const grant = validate(environment, action, input);
    await db.query('BEGIN');
    try {
      let changed = false;
      if (action === 'grant') {
        const client = (await db.query('SELECT id FROM identity.clients WHERE id=$1 AND status=$2', [grant.clientId, 'active'])).rows[0];
        if (!client) throw fail('client_inactive_or_missing');
        const previous = (await db.query(`SELECT client_id,operation,expires_at,granted_by,revoked_at FROM identity.${table} WHERE id=$1`, [grant.grantId])).rows[0];
        if (previous) {
          if (previous.client_id !== grant.clientId || previous.operation !== grant.operation || previous.expires_at.toISOString() !== grant.expiresAt
            || previous.granted_by.toLowerCase() !== grant.operatorReference || previous.revoked_at !== null) throw fail('grant_id_conflict');
        } else {
          const result = await db.query(`INSERT INTO identity.${table} (id,client_id,operation,expires_at,granted_by)
            SELECT $1,$2,$3,$4,$5 WHERE $4::TIMESTAMPTZ > clock_timestamp() AND $4::TIMESTAMPTZ <= clock_timestamp()+INTERVAL '90 days' RETURNING id`,
          [grant.grantId, grant.clientId, grant.operation, grant.expiresAt, grant.operatorReference]);
          if (result.rowCount !== 1) throw fail('invalid_expiry');
          changed = true;
        }
      } else {
        const previous = (await db.query(`SELECT revoked_at FROM identity.${table} WHERE id=$1 FOR UPDATE`, [grant.grantId])).rows[0];
        if (!previous) throw fail('grant_not_found');
        if (previous.revoked_at === null) {
          await db.query(`UPDATE identity.${table} SET revoked_at=now() WHERE id=$1`, [grant.grantId]); changed = true;
        }
      }
      if (changed) await db.query(`INSERT INTO identity.audit_events (actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
        VALUES ($1,$2,$3,$4,'success',$5,now()+INTERVAL '90 days')`, [grant.operatorReference, `${resourceType}.${action}`, resourceType, grant.grantId, randomUUID()]);
      await db.query('COMMIT');
      return { status: 'passed', environment, action, grantId: grant.grantId, changed };
    } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  }

  async function main() {
    const [environment, action, path, ...extra] = process.argv.slice(2);
    if (!path || extra.length || (await stat(path)).size > 1024) throw fail('invalid_command');
    const input = validate(environment, action, JSON.parse(await readFile(path, 'utf8')));
    const { settings, clientFor } = await import('./database.mjs');
    const config = await settings(environment);
    const url = new URL(config.url); url.pathname = '/' + config.database;
    const db = clientFor(url, config.ssl);
    try {
      await db.connect();
      const identity = (await db.query('SELECT current_database() AS database, current_user AS role')).rows[0];
      if (identity.database !== config.database || /^solventa_(local|dev|staging|prod)_/.test(identity.role)) throw fail('administrative_connection_required');
      console.log(JSON.stringify(await change(db, environment, action, input)));
    } finally { await db.end().catch(() => {}); }
  }

  function runWhenInvoked(moduleUrl) {
    if (process.argv[1] && moduleUrl === pathToFileURL(process.argv[1]).href) {
      main().catch(error => { console.error(JSON.stringify({ status: 'failed', code: /^[a-z_]{3,64}$/.test(error.code ?? '') ? error.code : failureCode })); process.exitCode = 1; });
    }
  }
  return { validate, change, runWhenInvoked };
}
