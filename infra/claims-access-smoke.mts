import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { settings, clientFor, owners, applyMigrations, applyRuntimeGrants } from './database.mjs';
import { changeClaimsGrant } from './claims-access.mjs';
import { SqlIdentitySessions } from '../backend/identity-consent-ecosystem/src/adapters/outbound/identity-sessions';
import { SqlClaimsAccessGrants } from '../backend/identity-consent-ecosystem/src/adapters/outbound/claims-access-grants';
import { ApiAccess } from '../backend/identity-consent-ecosystem/src/application/api-access';

const config = await settings('local');
const state = JSON.parse(await readFile('infra/.local/runtime.local.json', 'utf8'));
const name = 'solventa_claims_access_test_' + randomUUID().replaceAll('-', '');
assert.match(name, /^solventa_claims_access_test_[a-f0-9]{32}$/);
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
  const identity = { providerSubject: 'claims_synthetic_' + randomUUID(), sessionReference: 'claims_synthetic_' + randomUUID(), emailVerified: true };
  const principal = await sessions.open(identity);
  const permissions = new SqlClaimsAccessGrants(connection.toString());
  const access = new ApiAccess({ find: async () => null }, sessions, undefined, permissions);
  assert.equal((await access.webUser(identity, 'claims:read')).allowed, false);

  const grant = { grantId: randomUUID(), clientId: principal.clientId, operation: 'claims:read', expiresAt: new Date(Date.now() + 3600000).toISOString(), operatorReference: randomUUID() };
  assert.equal((await changeClaimsGrant(db, 'local', 'grant', grant)).changed, true);
  assert.equal((await changeClaimsGrant(db, 'local', 'grant', grant)).changed, false);
  await assert.rejects(changeClaimsGrant(db, 'local', 'grant', { ...grant, operation: 'claims:decide' }), /grant_id_conflict/);
  const allowed = await access.webUser(identity, 'claims:read');
  assert.equal(allowed.allowed, true);
  if (!allowed.allowed) throw new Error('synthetic_permission_missing');
  assert.ok(Date.parse(allowed.actor.authorizationExpiresAt!) <= Date.now() + 5000);
  assert.equal((await access.webUser(identity, 'claims:decide')).allowed, false);

  const runtime = clientFor(connection, { ca: config.ssl.ca, rejectUnauthorized: true });
  try {
    await runtime.connect();
    await assert.rejects(runtime.query('UPDATE identity.claims_access_grants SET revoked_at=now() WHERE id=$1', [grant.grantId]), error => error.code === '42501');
    await assert.rejects(runtime.query('INSERT INTO identity.claims_access_grants (client_id,operation,expires_at,granted_by) VALUES ($1,$2,now()+interval \'1 day\',$3)', [principal.clientId, 'claims:decide', 'runtime']), error => error.code === '42501');
  } finally { await runtime.end(); }
  await assert.rejects(db.query(`INSERT INTO identity.claims_access_grants (client_id,operation,expires_at,granted_by) VALUES ($1,'claims:other',now()+interval '1 day','operator')`, [principal.clientId]));

  await db.query("UPDATE identity.clients SET status='suspended' WHERE id=$1", [principal.clientId]);
  assert.equal(await permissions.find(principal, identity, 'claims:read'), null);
  await db.query("UPDATE identity.clients SET status='active' WHERE id=$1", [principal.clientId]);
  assert.equal(await permissions.find(principal, { ...identity, providerSubject: 'another-subject' }, 'claims:read'), null);
  assert.equal(await permissions.find(principal, { ...identity, sessionReference: 'another-session' }, 'claims:read'), null);

  await changeClaimsGrant(db, 'local', 'revoke', { grantId: grant.grantId, operatorReference: grant.operatorReference });
  assert.equal(await permissions.find(principal, identity, 'claims:read'), null);
  assert.equal((await changeClaimsGrant(db, 'local', 'revoke', { grantId: grant.grantId, operatorReference: grant.operatorReference })).changed, false);

  const uppercase = { grantId: randomUUID().toUpperCase(), clientId: principal.clientId.toUpperCase(), operation: 'claims:decide', expiresAt: new Date(Date.now() + 3600000).toISOString(), operatorReference: randomUUID() };
  assert.equal((await changeClaimsGrant(db, 'local', 'grant', uppercase)).changed, true);
  assert.equal((await changeClaimsGrant(db, 'local', 'grant', uppercase)).changed, false, 'an identical retry with uppercase UUIDs stays a no-op');
  assert.equal((await changeClaimsGrant(db, 'local', 'revoke', { grantId: uppercase.grantId, operatorReference: uppercase.operatorReference })).changed, true);

  const rolledBack = { ...grant, grantId: randomUUID() };
  const brokenAudit = { query: (sql: string, ...args: unknown[]) => sql.includes('INSERT INTO identity.audit_events') ? Promise.reject(new Error('synthetic_audit_failure')) : db!.query(sql, ...args) };
  await assert.rejects(changeClaimsGrant(brokenAudit, 'local', 'grant', rolledBack), /synthetic_audit_failure/);
  assert.equal((await db.query('SELECT id FROM identity.claims_access_grants WHERE id=$1', [rolledBack.grantId])).rowCount, 0);

  const expired = { ...grant, grantId: randomUUID(), operation: 'claims:decide', expiresAt: new Date(Date.now() + 50000).toISOString() };
  await changeClaimsGrant(db, 'local', 'grant', expired);
  assert.ok(await permissions.find(principal, identity, 'claims:decide'));
  await db.query("UPDATE identity.claims_access_grants SET granted_at=now()-INTERVAL '2 days', expires_at=now()-INTERVAL '1 day' WHERE id=$1", [expired.grantId]);
  assert.equal(await permissions.find(principal, identity, 'claims:decide'), null);
  console.log(JSON.stringify({ environment: 'local', status: 'passed', cases: ['runtime-read-only', 'explicit-grant', 'per-operation', 'revoke', 'expiry', 'session-binding', 'suspension', 'audit-rollback'] }));
} finally {
  if (db) await db.end();
  if (created && migrated) await admin.query(`DROP DATABASE ${name} CASCADE`);
  else if (created) console.log(JSON.stringify({ preservedGeneratedDatabaseForReconciliation: name }));
  await admin.end();
}
