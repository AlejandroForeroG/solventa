import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { settings, clientFor, owners, applyMigrations, applyRuntimeGrants, verifyNoSchemaCreate } from './database.mjs';
import { SqlIdentitySessions } from '../backend/identity-consent-ecosystem/src/adapters/outbound/identity-sessions';
import { SqlNotificationPreferences } from '../backend/identity-consent-ecosystem/src/adapters/outbound/sql-notification-preferences';
import { NotificationPreferences } from '../backend/identity-consent-ecosystem/src/application/notification-preferences';
import { canonicalNotificationRequest, defaultNotificationMatrix, NotificationPreferenceFailure } from '../backend/identity-consent-ecosystem/src/domain/notification-preferences';

const config = await settings('local');
const name = `solventa_notification_test_${randomUUID().replaceAll('-', '')}`;
assert.match(name, /^solventa_notification_test_[a-f0-9]{32}$/);
const owner = owners.find(item => item.schema === 'identity')!;
const admin = clientFor(config.url, config.ssl);
let created = false;
let db: ReturnType<typeof clientFor> | undefined;
try {
  await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); created = true;
  const url = new URL(config.url); url.pathname = `/${name}`;
  db = clientFor(url, config.ssl); await db.connect();
  await db.query('CREATE SCHEMA identity');
  await db.query('REVOKE ALL ON SCHEMA identity FROM public');
  await db.query('CREATE TABLE identity.schema_migrations (version STRING PRIMARY KEY, checksum STRING NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  await applyMigrations(db, owner);
  const ledger = (await db.query('SELECT version,checksum FROM identity.schema_migrations ORDER BY version')).rows;
  await applyMigrations(db, owner);
  assert.deepEqual((await db.query('SELECT version,checksum FROM identity.schema_migrations ORDER BY version')).rows, ledger);
  assert.ok(ledger.some(row => row.version === '0011_notification_preferences.sql'));
  const state = JSON.parse(await readFile('infra/.local/runtime.local.json', 'utf8'));
  await db.query(`GRANT CONNECT ON DATABASE ${name} TO solventa_local_identity`);
  await db.query('GRANT USAGE ON SCHEMA identity TO solventa_local_identity');
  await applyRuntimeGrants(db, owner, 'solventa_local_identity', JSON.parse(await readFile(`backend/${owner.name}/runtime-grants.json`, 'utf8')));
  const runtime = new URL(url); runtime.username = 'solventa_local_identity'; runtime.password = state.passwords.identity;
  runtime.searchParams.set('sslmode', 'verify-full'); runtime.searchParams.set('sslrootcert', 'infra/.local/certs/ca.crt');
  const runtimeDb = clientFor(runtime, { ca: config.ssl.ca, rejectUnauthorized: true });
  await runtimeDb.connect();
  try {
    await verifyNoSchemaCreate(runtimeDb, 'identity');
    await assert.rejects(runtimeDb.query('DELETE FROM identity.notification_preferences WHERE false'), { code: '42501' });
    await assert.rejects(runtimeDb.query('DELETE FROM identity.notification_preference_commands WHERE false'), { code: '42501' });
  } finally { await runtimeDb.end(); }
  const sessions = new SqlIdentitySessions(runtime.toString());
  const store = new SqlNotificationPreferences(runtime.toString());
  const app = new NotificationPreferences(store);
  const identity = { providerSubject: `synthetic_${randomUUID()}`, sessionReference: `synthetic_${randomUUID()}`, emailVerified: true };
  const other = { providerSubject: `synthetic_${randomUUID()}`, sessionReference: `synthetic_${randomUUID()}`, emailVerified: true };
  const principal = await sessions.open(identity);
  const outsider = await sessions.open(other);
  const initial = await app.read(principal.clientId, identity);
  assert.equal(initial.version, 0); assert.deepEqual(initial.preferences, defaultNotificationMatrix);
  const matrix = structuredClone(initial.preferences); matrix.claims.email = true; matrix.claims.push = true;
  const key = randomUUID(); const traceId = randomUUID();
  const requestHash = createHash('sha256').update(canonicalNotificationRequest(0, matrix)).digest('hex');
  const input = { clientId: principal.clientId, actor: principal.subjectToken, identity, preferences: matrix,
    expectedVersion: 0, key, traceId, requestHash };
  const saved = await app.save(input);
  assert.equal(saved.version, 1);
  assert.deepEqual(await app.save(input), saved);
  assert.equal((await app.read(principal.clientId, identity)).preferences.claims.push, true);
  await assert.rejects(app.save({ ...input, key: randomUUID() }), (error: unknown) => error instanceof NotificationPreferenceFailure && error.code === 'conflict');
  await assert.rejects(app.save({ ...input, requestHash: createHash('sha256').update('different').digest('hex') }),
    (error: unknown) => error instanceof NotificationPreferenceFailure && error.code === 'conflict');
  await assert.rejects(app.read(principal.clientId, other), (error: unknown) => error instanceof NotificationPreferenceFailure && error.code === 'unauthorized');
  assert.equal((await app.read(outsider.clientId, other)).version, 0);
  const events = (await db.query("SELECT payload FROM identity.outbox_events WHERE aggregate_type='notification_preferences' AND aggregate_id=$1", [principal.clientId])).rows;
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload.capture.inputs.preferences, matrix);
  assert.equal((await db.query("SELECT count(*)::INT4 AS count FROM identity.audit_events WHERE action='notification_preferences.updated' AND resource_id=$1", [principal.clientId])).rows[0].count, 1);
  const changed = structuredClone(matrix); changed.payments.sms = true;
  const next = { ...input, preferences: changed, expectedVersion: 1, key: randomUUID(),
    requestHash: createHash('sha256').update(canonicalNotificationRequest(1, changed)).digest('hex') };
  await db.query('REVOKE INSERT ON identity.audit_events FROM solventa_local_identity');
  try { await assert.rejects(app.save(next), { code: '42501' }); }
  finally { await db.query('GRANT INSERT ON identity.audit_events TO solventa_local_identity'); }
  assert.deepEqual(await app.read(principal.clientId, identity), saved);
  assert.equal((await db.query('SELECT count(*)::INT4 AS count FROM identity.notification_preference_commands WHERE client_id=$1', [principal.clientId])).rows[0].count, 1);
  await db.query('UPDATE identity.authentication_sessions SET revoked_at=now() WHERE provider_session=$1', [identity.sessionReference]);
  await assert.rejects(app.read(principal.clientId, identity), (error: unknown) => error instanceof NotificationPreferenceFailure && error.code === 'unauthorized');
  await assert.rejects(app.save(next), (error: unknown) => error instanceof NotificationPreferenceFailure && error.code === 'unauthorized');
  console.log(JSON.stringify({ environment: 'isolated local', checks: ['migrations', 'runtime grants', 'idempotency',
    'owner isolation', 'audit and outbox', 'rollback', 'session revocation'], status: 'passed' }));
} finally {
  await db?.end();
  if (created) { assert.match(name, /^solventa_notification_test_[a-f0-9]{32}$/); await admin.query(`DROP DATABASE ${name} CASCADE`); }
  await admin.end();
}
