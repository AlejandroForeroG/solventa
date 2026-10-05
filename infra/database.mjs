import { Client } from 'pg';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { remoteEnvironments } from './environments.mjs';

export const owners = [
  { name: 'acquisition-risk', schema: 'acquisition', binding: 'ACQUISITION_DB' },
  { name: 'identity-consent-ecosystem', schema: 'identity', binding: 'IDENTITY_DB' },
  { name: 'policy-claims-payments', schema: 'policy', binding: 'POLICY_DB' },
];
export async function settings(environment) {
  if (!['local', ...remoteEnvironments].includes(environment)) throw Error('Unsupported environment');
  // Read only this environment's file; sequential operations cannot inherit another origin.
  const variables = parseEnv(await readFile(`.env.infra.${environment}`, 'utf8'));
  const url = new URL(variables.DATABASE_URL);
  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) url.searchParams.delete(key);
  if (environment === 'local' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw Error('Local database must be loopback');
  if (environment !== 'local' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) throw Error('Remote database must not be loopback');
  const ssl = { rejectUnauthorized: true };
  for (const [key, variable] of [['ca', 'DATABASE_CA_FILE'], ['cert', 'DATABASE_CERT_FILE'], ['key', 'DATABASE_KEY_FILE']]) {
    if (variables[variable]) ssl[key] = await readFile(variables[variable], 'utf8');
  }
  return { url, ssl, database: `solventa_${environment}` };
}
export function clientFor(url, ssl) {
  const client = new Client({ connectionString: url.toString(), ssl, connectionTimeoutMillis: 15000, query_timeout: 30000 });
  client.on('error', () => {});
  return client;
}
const id = (s) => '"' + s.replaceAll('"', '""') + '"';
const literal = (s) => "'" + s.replaceAll("'", "''") + "'";
export function migrationChecksums(sql) {
  const normalized = sql.replaceAll('\r\n', '\n');
  const hash = value => createHash('sha256').update(value).digest('hex');
  return { canonical: hash(normalized), accepted: new Set([hash(normalized), hash(normalized.replaceAll('\n', '\r\n'))]) };
}
export function validateRuntimeGrants(grants) {
  if (!grants || typeof grants !== 'object' || Array.isArray(grants)) throw Error('Invalid runtime grants');
  for (const [table, privileges] of Object.entries(grants)) {
    if (!/^[a-z][a-z0-9_]*$/.test(table) || ['schema_migrations', 'schema_migration_failures'].includes(table) || !Array.isArray(privileges) || !privileges.length ||
      privileges.some(p => !['SELECT', 'INSERT', 'UPDATE'].includes(p)) || new Set(privileges).size !== privileges.length) throw Error('Invalid runtime grants');
  }
  return grants;
}
export async function applyRuntimeGrants(db, owner, role, grants) {
  validateRuntimeGrants(grants);
  const plans = [];
  // GRANT/REVOKE can outlive ROLLBACK in CockroachDB. Preflight every table,
  // then reconcile differences without removing any desired runtime privilege.
  for (const [table, desired] of Object.entries(grants)) {
    const target = `${id(owner.schema)}.${id(table)}`;
    const rows = (await db.query(`SHOW GRANTS ON TABLE ${target}`)).rows;
    const own = rows.filter(row => row.grantee === role);
    if (own.some(row => row.privilege_type === 'ALL' || row.is_grantable)) {
      throw Object.assign(Error('Reconcile overprivileged runtime role administratively'), {code: 'runtime_privileges_too_broad'});
    }
    const current = own.map(row => row.privilege_type);
    if (current.some(privilege => !/^[A-Z]+$/.test(privilege))) throw Error('Unsupported catalog privilege');
    plans.push({target, missing: desired.filter(privilege => !current.includes(privilege)),
      surplus: current.filter(privilege => !desired.includes(privilege)), publicAccess: rows.some(row => row.grantee === 'public')});
  }
  for (const {target, missing, surplus, publicAccess} of plans) {
    if (publicAccess) await db.query(`REVOKE ALL ON TABLE ${target} FROM public`);
    if (surplus.length) await db.query(`REVOKE ${surplus.join(', ')} ON TABLE ${target} FROM ${id(role)}`);
    if (missing.length) await db.query(`GRANT ${missing.join(', ')} ON TABLE ${target} TO ${id(role)}`);
  }
}
export async function applyMigrations(db, owner) {
  // Persist intent outside the DDL transaction. CockroachDB XXA00 can commit
  // ledger DML while failing a schema change; a checksum alone is insufficient.
  const guard = `${id(owner.schema)}.schema_migration_failures`;
  await db.query(`CREATE TABLE IF NOT EXISTS ${guard} (version STRING PRIMARY KEY, checksum STRING NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), error_code STRING)`);
  await db.query(`REVOKE ALL ON TABLE ${guard} FROM public`);
  if ((await db.query(`SELECT version FROM ${guard}`)).rowCount) {
    throw Object.assign(Error('Inspect and reconcile incomplete migrations before replay'), { code: 'migration_reconciliation_required' });
  }
  const migrations = (await readdir(`backend/${owner.name}/migrations`)).filter(f => f.endsWith('.sql')).sort();
  for (const version of migrations) {
    const sql = await readFile(`backend/${owner.name}/migrations/${version}`, 'utf8');
    const checksums = migrationChecksums(sql);
    const checksum = checksums.canonical;
    const applied = (await db.query(`SELECT checksum FROM ${id(owner.schema)}.schema_migrations WHERE version=$1`, [version])).rows[0];
    if (applied) { if (!checksums.accepted.has(applied.checksum)) throw Error('Applied migration changed'); continue; }
    // DDL may reset transaction-local settings; select the owner on the connection.
    await db.query(`SET search_path = ${id(owner.schema)}`);
    await db.query(`INSERT INTO ${guard} (version, checksum) VALUES ($1,$2)`, [version, checksum]);
    try {
      await db.query('BEGIN');
      await db.query({ text: sql, query_timeout: 120000 });
      await db.query(`INSERT INTO ${id(owner.schema)}.schema_migrations (version,checksum) VALUES ($1,$2)`, [version,checksum]);
      await db.query('COMMIT');
      await db.query(`DELETE FROM ${guard} WHERE version=$1`, [version]);
    } catch (error) {
      error.migration = `${owner.schema}/${version}`;
      try { await db.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      try { await db.query(`UPDATE ${guard} SET error_code=$2 WHERE version=$1`, [version, error.code ?? 'migration_failed']); } catch { /* Durable intent still blocks replay. */ }
      throw error;
    }
  }
}
export async function runtimeState(environment, config, admin, statePath) {
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // User names are cluster-wide. Never invent replacements for existing passwords.
    const roles = owners.map(owner => `solventa_${environment}_${owner.schema}`);
    const existing = await admin.query('SHOW USERS');
    if (existing.rows.some(user => roles.includes(user.username))) {
      throw Object.assign(Error('Restore the custodied runtime state before provisioning existing users'), { code: 'runtime_state_missing' });
    }
    state = { database: config.database, passwords: Object.fromEntries(owners.map(o => [o.schema, randomBytes(32).toString('hex')])) };
    await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  }
  if (state.database !== config.database || owners.some(owner => !/^[a-f0-9]{64}$/.test(state.passwords?.[owner.schema] ?? ''))) throw Error('Invalid database credential state');
  return state;
}
export async function provision(environment) {
  const config = await settings(environment);
  const statePath = `infra/.local/runtime.${environment}.json`;
  await mkdir('infra/.local', { recursive: true });
  let state;
  const admin = clientFor(config.url, config.ssl);
  try {
    await admin.connect();
    state = await runtimeState(environment, config, admin, statePath);
    await admin.query(`CREATE DATABASE IF NOT EXISTS ${id(config.database)}`);
  } finally { await admin.end(); }
  const url = new URL(config.url); url.pathname = '/' + config.database;
  const db = clientFor(url, config.ssl);
  try {
    await db.connect();
    await db.query(`REVOKE ALL ON DATABASE ${id(config.database)} FROM public`);
    await db.query('REVOKE ALL ON SCHEMA public FROM public');
    for (const owner of owners) {
      const role = `solventa_${environment}_${owner.schema}`;
      await db.query(`CREATE USER IF NOT EXISTS ${id(role)} WITH PASSWORD ${literal(state.passwords[owner.schema])}`);
      await db.query(`CREATE SCHEMA IF NOT EXISTS ${id(owner.schema)}`);
      await db.query(`REVOKE ALL ON SCHEMA ${id(owner.schema)} FROM public`);
      await db.query(`GRANT CONNECT ON DATABASE ${id(config.database)} TO ${id(role)}`);
      await db.query(`GRANT USAGE ON SCHEMA ${id(owner.schema)} TO ${id(role)}`);
      await db.query(`CREATE TABLE IF NOT EXISTS ${id(owner.schema)}.schema_migrations (version STRING PRIMARY KEY, checksum STRING NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await applyMigrations(db, owner);
      // Runtime roles can read the migration ledger; they cannot mutate DDL or it.
      await db.query(`GRANT SELECT ON TABLE ${id(owner.schema)}.schema_migrations TO ${id(role)}`);
      const grants = validateRuntimeGrants(JSON.parse(await readFile(`backend/${owner.name}/runtime-grants.json`, 'utf8')));
      await applyRuntimeGrants(db, owner, role, grants);
    }
  } finally { await db.end(); }
  console.log(JSON.stringify({ database: config.database, schemas: owners.map(o => o.schema), status: 'provisioned' }));
}
export async function verifyIsolation(environment) {
  const config = await settings(environment);
  const state = JSON.parse(await readFile(`infra/.local/runtime.${environment}.json`, 'utf8'));
  const results = [];
  for (const owner of owners) {
    const url = new URL(config.url); url.pathname = '/' + config.database; url.username = `solventa_${environment}_${owner.schema}`; url.password = state.passwords[owner.schema];
    const client = clientFor(url, { ca: config.ssl.ca, rejectUnauthorized: true });
    try {
      await client.connect();
      await client.query(`SELECT count(*) FROM ${id(owner.schema)}.schema_migrations`);
      const attempts = owners.filter(other => other.schema !== owner.schema).map(other => `SELECT * FROM ${id(other.schema)}.schema_migrations`);
      attempts.push(`CREATE TABLE ${id(owner.schema)}.unauthorized_probe (id INT)`);
      for (const sql of attempts) {
        let denied = false;
        try { await client.query(sql); } catch (error) { if (error.code !== '42501') throw error; denied = true; }
        if (!denied) throw Error('Runtime isolation failed');
      }
      results.push({ schema: owner.schema, ownRead: true, crossReadDenied: true, ddlDenied: true });
    } finally { await client.end(); }
  }
  console.log(JSON.stringify({ environment, results }));
}
export async function verifyEnvironmentIsolation(environment) {
  const config = await settings(environment);
  const state = JSON.parse(await readFile(`infra/.local/runtime.${environment}.json`, 'utf8'));
  const results = [];
  for (const owner of owners) {
    const url = new URL(config.url);
    url.pathname = '/' + config.database;
    url.username = `solventa_${environment}_${owner.schema}`;
    url.password = state.passwords[owner.schema];
    const client = clientFor(url, { ca: config.ssl.ca, rejectUnauthorized: true });
    try {
      await client.connect();
      for (const other of remoteEnvironments.filter(e => e !== environment)) {
        let denied = false;
        try { await client.query(`SELECT version FROM ${id(`solventa_${other}`)}.${id(owner.schema)}.schema_migrations`); }
        catch (error) { if (error.code !== '42501') throw error; denied = true; }
        if (!denied) throw Error('Cross-environment read allowed');
        results.push({ schema: owner.schema, target: other, crossEnvironmentReadDenied: true });
      }
    } finally { await client.end(); }
  }
  console.log(JSON.stringify({ environment, environmentIsolation: results }));
}
if (process.argv[1] === resolve('infra/database.mjs')) {
  try {
    const [action, environment] = process.argv.slice(2);
    if (action === 'provision') await provision(environment);
    else if (action === 'verify') await verifyIsolation(environment);
    else throw Error('Unknown action');
  } catch (error) { console.error(JSON.stringify({ error: error.code ?? 'infra_failed' })); process.exitCode = 1; }
}
