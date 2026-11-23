import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { settings, clientFor, owners, applyMigrations, applyRuntimeGrants } from './database.mjs';
import { changeReportGrant } from './report-access.mjs';
import { SqlIdentitySessions } from '../backend/identity-consent-ecosystem/src/adapters/outbound/identity-sessions';
import { SqlReportAccessGrants } from '../backend/identity-consent-ecosystem/src/adapters/outbound/report-access-grants';
import { ApiAccess } from '../backend/identity-consent-ecosystem/src/application/api-access';

const config = await settings('local');
const state = JSON.parse(await readFile('infra/.local/runtime.local.json', 'utf8'));
const name = 'solventa_report_access_test_' + randomUUID().replaceAll('-', '');
assert.match(name, /^solventa_report_access_test_[a-f0-9]{32}$/);
const admin = clientFor(config.url, config.ssl);
let created = false;
let migrated = false;
let db: ReturnType<typeof clientFor> | undefined;
try {
  await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); created = true;
  const url = new URL(config.url); url.pathname = '/' + name;
  db = clientFor(url, config.ssl); await db.connect();
  const owner = owners.find(candidate => candidate.schema === 'identity')!;
  await db.query(`CREATE SCHEMA ${owner.schema}`);
  await db.query(`CREATE TABLE ${owner.schema}.schema_migrations (version STRING PRIMARY KEY, checksum STRING NOT NULL, applied_at TIMESTAMPTZ DEFAULT now())`);
  await applyMigrations(db, owner);
  const role = `solventa_local_${owner.schema}`;
  await db.query(`GRANT CONNECT ON DATABASE ${name} TO ${role}`);
  await db.query(`GRANT USAGE ON SCHEMA ${owner.schema} TO ${role}`);
  await applyRuntimeGrants(db, owner, role, JSON.parse(await readFile(`backend/${owner.name}/runtime-grants.json`, 'utf8')));
  const connection = new URL(url); connection.username = role; connection.password = state.passwords[owner.schema];
  connection.searchParams.set('sslmode', 'verify-full'); connection.searchParams.set('sslrootcert', 'infra/.local/certs/ca.crt');
  migrated = true;

  const sessions = new SqlIdentitySessions(connection.toString());
  const identity = { providerSubject: 'reports_synthetic_' + randomUUID(), sessionReference: 'reports_synthetic_' + randomUUID(), emailVerified: true };
  const principal = await sessions.open(identity);
  const permissions = new SqlReportAccessGrants(connection.toString());
  const access = new ApiAccess({ find: async () => null }, sessions, undefined, undefined, undefined, undefined, permissions);
  assert.equal((await access.webUser(identity, 'reports:read')).allowed, false);

  const grant = { grantId: randomUUID(), clientId: principal.clientId, operation: 'reports:read', expiresAt: new Date(Date.now() + 3600000).toISOString(), operatorReference: randomUUID() };
  assert.equal((await changeReportGrant(db, 'local', 'grant', grant)).changed, true);
  assert.equal((await changeReportGrant(db, 'local', 'grant', grant)).changed, false);
  await assert.rejects(changeReportGrant(db, 'local', 'grant', { ...grant, operation: 'reports:send' }), /grant_id_conflict/);
  const allowed = await access.webUser(identity, 'reports:read');
  assert.equal(allowed.allowed, true);
  if (!allowed.allowed) throw new Error('synthetic_permission_missing');
  assert.ok(Date.parse(allowed.actor.authorizationExpiresAt!) <= Date.now() + 5000);
  assert.equal((await access.webUser(identity, 'reports:send')).allowed, false);
  assert.equal((await access.webUser(identity, 'claims:read')).allowed, false, 'a report grant never opens the claims inbox');

  const runtime = clientFor(connection, { ca: config.ssl.ca, rejectUnauthorized: true });
  try {
    await runtime.connect();
    await assert.rejects(runtime.query('UPDATE identity.report_access_grants SET revoked_at=now() WHERE id=$1', [grant.grantId]), error => error.code === '42501');
    await assert.rejects(runtime.query('INSERT INTO identity.report_access_grants (client_id,operation,expires_at,granted_by) VALUES ($1,$2,now()+interval \'1 day\',$3)', [principal.clientId, 'reports:send', 'runtime']), error => error.code === '42501');
  } finally { await runtime.end(); }
  await assert.rejects(db.query(`INSERT INTO identity.report_access_grants (client_id,operation,expires_at,granted_by) VALUES ($1,'reports:other',now()+interval '1 day','operator')`, [principal.clientId]));

  await db.query("UPDATE identity.clients SET status='suspended' WHERE id=$1", [principal.clientId]);
  assert.equal(await permissions.find(principal, identity, 'reports:read'), null);
  await db.query("UPDATE identity.clients SET status='active' WHERE id=$1", [principal.clientId]);
  assert.equal(await permissions.find(principal, { ...identity, providerSubject: 'another-subject' }, 'reports:read'), null);
  assert.equal(await permissions.find(principal, { ...identity, sessionReference: 'another-session' }, 'reports:read'), null);

  await changeReportGrant(db, 'local', 'revoke', { grantId: grant.grantId, operatorReference: grant.operatorReference });
  assert.equal(await permissions.find(principal, identity, 'reports:read'), null);
  assert.equal((await changeReportGrant(db, 'local', 'revoke', { grantId: grant.grantId, operatorReference: grant.operatorReference })).changed, false);

  const uppercase = { grantId: randomUUID().toUpperCase(), clientId: principal.clientId.toUpperCase(), operation: 'reports:send', expiresAt: new Date(Date.now() + 3600000).toISOString(), operatorReference: randomUUID() };
  assert.equal((await changeReportGrant(db, 'local', 'grant', uppercase)).changed, true);
  assert.equal((await changeReportGrant(db, 'local', 'grant', uppercase)).changed, false, 'an identical retry with uppercase UUIDs stays a no-op');
  assert.equal((await changeReportGrant(db, 'local', 'revoke', { grantId: uppercase.grantId, operatorReference: uppercase.operatorReference })).changed, true);

  const rolledBack = { ...grant, grantId: randomUUID() };
  const brokenAudit = { query: (sql: string, ...args: unknown[]) => sql.includes('INSERT INTO identity.audit_events') ? Promise.reject(new Error('synthetic_audit_failure')) : db!.query(sql, ...args) };
  await assert.rejects(changeReportGrant(brokenAudit, 'local', 'grant', rolledBack), /synthetic_audit_failure/);
  assert.equal((await db.query('SELECT id FROM identity.report_access_grants WHERE id=$1', [rolledBack.grantId])).rowCount, 0);

  const expired = { ...grant, grantId: randomUUID(), operation: 'reports:send', expiresAt: new Date(Date.now() + 50000).toISOString() };
  await changeReportGrant(db, 'local', 'grant', expired);
  assert.ok(await permissions.find(principal, identity, 'reports:send'));
  await db.query("UPDATE identity.report_access_grants SET granted_at=now()-INTERVAL '2 days', expires_at=now()-INTERVAL '1 day' WHERE id=$1", [expired.grantId]);
  assert.equal(await permissions.find(principal, identity, 'reports:send'), null);
  console.log(JSON.stringify({ environment: 'local', status: 'passed', cases: ['runtime-read-only', 'explicit-grant', 'per-operation', 'revoke', 'expiry', 'session-binding', 'suspension', 'audit-rollback'] }));
} finally {
  if (db) await db.end();
  if (created && migrated) await admin.query(`DROP DATABASE ${name} CASCADE`);
  else if (created) console.log(JSON.stringify({ preservedGeneratedDatabaseForReconciliation: name }));
  await admin.end();
}
