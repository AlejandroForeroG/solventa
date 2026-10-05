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
export function validateRuntimeGrants(grants) {
  if (!grants || typeof grants !== 'object' || Array.isArray(grants)) throw Error('Invalid runtime grants');
  for (const [table, privileges] of Object.entries(grants)) {
    if (!/^[a-z][a-z0-9_]*$/.test(table) || table === 'schema_migrations' || !Array.isArray(privileges) || !privileges.length ||
      privileges.some(p => !['SELECT', 'INSERT', 'UPDATE'].includes(p)) || new Set(privileges).size !== privileges.length) throw Error('Invalid runtime grants');
  }
  return grants;
}
export async function applyMigrations(db, owner) {
  const migrations = (await readdir(`backend/${owner.name}/migrations`)).filter(f => f.endsWith('.sql')).sort();
  for (const version of migrations) {
    const sql = await readFile(`backend/${owner.name}/migrations/${version}`, 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const applied = (await db.query(`SELECT checksum FROM ${id(owner.schema)}.schema_migrations WHERE version=$1`, [version])).rows[0];
    if (applied) { if (applied.checksum !== checksum) throw Error('Applied migration changed'); continue; }
    // DDL may reset transaction-local settings; select the owner on the connection.
    await db.query(`SET search_path = ${id(owner.schema)}`);
    await db.query('BEGIN');
    try {
      await db.query({ text: sql, query_timeout: 120000 });
      await db.query(`INSERT INTO ${id(owner.schema)}.schema_migrations (version,checksum) VALUES ($1,$2)`, [version,checksum]);
      await db.query('COMMIT');
    } catch (error) { error.migration = `${owner.schema}/${version}`; await db.query('ROLLBACK'); throw error; }
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
      for (const [table, privileges] of Object.entries(grants)) {
        await db.query(`REVOKE ALL ON TABLE ${id(owner.schema)}.${id(table)} FROM public`);
        await db.query(`REVOKE ALL ON TABLE ${id(owner.schema)}.${id(table)} FROM ${id(role)}`);
        await db.query(`GRANT ${privileges.join(', ')} ON TABLE ${id(owner.schema)}.${id(table)} TO ${id(role)}`);
      }
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
