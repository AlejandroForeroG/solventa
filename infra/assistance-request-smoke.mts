import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { settings, clientFor, owners, applyMigrations } from './database.mjs';
import { SqlAssistanceRequests } from '../backend/policy-claims-payments/src/adapters/outbound/sql-assistance-requests';
import { findSyntheticProvider } from '../backend/policy-claims-payments/src/adapters/outbound/synthetic-assistance-directory';
import { newAssistanceReference } from '../backend/policy-claims-payments/src/adapters/outbound/random-assistance-reference';
import { AssistanceRequests } from '../backend/policy-claims-payments/src/application/assistance-requests';

// Real disposable SQL with the real Policy runtime grants and migrations; nothing remote is touched.
const config = await settings('local');
assert.equal(config.database, 'solventa_local');
const name = 'solventa_assistance_request_test_' + randomUUID().replaceAll('-', '');
assert.match(name, /^solventa_assistance_request_test_[a-f0-9]{32}$/);
const admin = clientFor(config.url, config.ssl);
let created = false;
let migrated = false;
let db: ReturnType<typeof clientFor> | undefined;
try {
  await admin.connect();
  const held = JSON.parse(await readFile('infra/.local/runtime.local.json', 'utf8'));
  const users = (await admin.query('SHOW USERS')).rows;
  if (!users.some(user => user.username === 'solventa_local_policy')) await admin.query(`CREATE USER solventa_local_policy WITH PASSWORD '${held.passwords.policy}'`);
  await admin.query(`CREATE DATABASE ${name}`); created = true;
  const url = new URL(config.url); url.pathname = '/' + name;
  db = clientFor(url, config.ssl); await db.connect();
  await db.query('CREATE SCHEMA policy');
  await db.query('CREATE TABLE policy.schema_migrations(version STRING PRIMARY KEY,checksum STRING NOT NULL,applied_at TIMESTAMPTZ DEFAULT now())');
  const owner = owners.find(candidate => candidate.schema === 'policy')!;
  await applyMigrations(db, owner);
  await applyMigrations(db, owner);
  migrated = true;
  const grants = JSON.parse(await readFile('backend/policy-claims-payments/runtime-grants.json', 'utf8')) as Record<string, string[]>;
  await db.query(`GRANT CONNECT ON DATABASE ${name} TO solventa_local_policy`);
  await db.query('GRANT USAGE ON SCHEMA policy TO solventa_local_policy');
  for (const [table, privileges] of Object.entries(grants)) await db.query(`GRANT ${privileges.join(',')} ON policy.${table} TO solventa_local_policy`);
  const runtime = new URL(url); runtime.username = 'solventa_local_policy'; runtime.password = held.passwords.policy;
  runtime.searchParams.set('sslmode', 'verify-full'); runtime.searchParams.set('sslrootcert', 'infra/.local/certs/ca.crt');

  const ownerA = { clientId: randomUUID(), subjectToken: randomUUID() };
  const ownerB = { clientId: randomUUID(), subjectToken: randomUUID() };
  const store = new SqlAssistanceRequests(runtime.toString());
  const requests = new AssistanceRequests(store, { find: id => findSyntheticProvider(id) }, { sha256Hex: async text => createHash('sha256').update(text).digest('hex') }, newAssistanceReference);
  const traceId = randomUUID();
  const address = { providerId: 'demo-bog-workshop', place: { kind: 'address' as const, address: 'Calle de prueba 10, Bogotá' } };
  const device = { providerId: 'demo-med-roadside', place: { kind: 'device' as const, latitude: 6.244001, longitude: -75.581 } };

  const first = await requests.create(ownerA, address, 'retry-key-0001', traceId);
  assert.equal(first.status, 'created');
  const request = (first as { request: { id: string; reference: string; status: string; provider: { name: string }; place: unknown; createdAt: string } }).request;
  assert.match(request.reference, /^ASI-[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.deepEqual([request.status, request.provider.name, request.place], ['requested', 'Taller de prueba Bogotá', { kind: 'address', address: 'Calle de prueba 10, Bogotá' }]);
  assert.ok(Math.abs(Date.now() - Date.parse(request.createdAt)) < 60_000, 'the request carries the date it was made');

  const replay = await requests.create(ownerA, address, 'retry-key-0001', randomUUID());
  assert.deepEqual(replay, { status: 'replayed', request });
  assert.equal((await requests.create(ownerA, device, 'retry-key-0001', randomUUID())).status, 'idempotency_conflict');
  assert.equal((await requests.create(ownerB, address, 'retry-key-0001', randomUUID())).status, 'created', 'a key belongs to its owner');
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM policy.assistance_requests WHERE subject_token=$1', [ownerA.subjectToken])).rows[0].n), 1, 'a retry creates no second request');

  const racing = await Promise.all([1, 2, 3].map(() => requests.create(ownerA, device, 'race-key-00001', randomUUID())));
  assert.deepEqual(racing.map(result => result.status).sort(), ['created', 'replayed', 'replayed'], 'simultaneous identical requests make one');
  const located = (racing.find(result => result.status === 'created') as { request: { id: string; place: unknown } }).request;
  assert.deepEqual(located.place, { kind: 'device', latitude: 6.244001, longitude: -75.581 });
  const stored = (await db.query('SELECT latitude::STRING AS lat, longitude::STRING AS lon, location_authorized_at IS NOT NULL AS authorized, address FROM policy.assistance_requests WHERE id=$1', [located.id])).rows[0];
  assert.deepEqual([stored.lat, stored.lon, stored.authorized, stored.address], ['6.244001', '-75.581000', true, null], 'a device position is stored with the moment it was authorized');
  const typed = (await db.query('SELECT latitude, location_authorized_at, address FROM policy.assistance_requests WHERE id=$1', [request.id])).rows[0];
  assert.deepEqual([typed.latitude, typed.location_authorized_at, typed.address], [null, null, 'Calle de prueba 10, Bogotá'], 'a typed address stores no position');

  assert.deepEqual(await store.get(ownerA, request.id), request, 'the owner follows the request');
  assert.equal(await store.get(ownerB, request.id), null, 'another customer sees nothing');
  assert.equal(await store.get(ownerA, randomUUID()), null);
  const listed = await store.listOwn(ownerA, 20);
  assert.deepEqual(listed.map(entry => entry.id).sort(), [request.id, located.id].sort());
  assert.ok(listed[0].createdAt >= listed[1].createdAt, 'newest first');
  assert.equal((await store.listOwn(ownerB, 20)).length, 1);
  assert.equal((await store.listOwn(ownerA, 1)).length, 1, 'the list is bounded');

  const references = new Set((await db.query('SELECT reference FROM policy.assistance_requests')).rows.map(row => row.reference));
  assert.equal(references.size, 3, 'every request has its own reference');
  const audit = (await db.query(`SELECT action, resource_type, outcome FROM policy.audit_events WHERE action='assistance.request.create'`)).rows;
  assert.equal(audit.length, 3);
  assert.ok(audit.every(row => row.resource_type === 'assistance_request' && row.outcome === 'success'));

  const runtimeClient = clientFor(runtime, { ca: config.ssl.ca, rejectUnauthorized: true });
  try {
    await runtimeClient.connect();
    for (const statement of ['UPDATE policy.assistance_requests SET status=\'requested\'', 'DELETE FROM policy.assistance_requests']) {
      await assert.rejects(runtimeClient.query(statement), error => error.code === '42501', statement);
    }
  } finally { await runtimeClient.end(); }

  const row = (change: string) => db!.query(`UPDATE policy.assistance_requests SET ${change} WHERE id=$1`, [request.id]);
  for (const change of ["status = 'dispatched'", "reference = 'ASI-lowercase'", "place_kind = 'device'", 'latitude = 4', "address = 'x'", "provider_kind = 'garage'", "request_hash = 'short'", "provider_phone = '123'"]) {
    await assert.rejects(row(change), /violat|constraint|check|regex/i, change);
  }
  await assert.rejects(db.query(`UPDATE policy.assistance_requests SET latitude = 91, longitude = 1, address = NULL, place_kind = 'device', location_authorized_at = now() WHERE id=$1`, [located.id]), /violat|constraint|check/i, 'a position out of range');
  await assert.rejects(db.query(`UPDATE policy.assistance_requests SET location_authorized_at = NULL WHERE id=$1`, [located.id]), /violat|constraint|check/i, 'a position without its authorization');
  console.log(JSON.stringify({ environment: 'local', status: 'passed', cases: ['create', 'idempotent-replay', 'payload-conflict', 'key-per-owner', 'concurrent-identical-requests', 'device-position', 'typed-address',
    'owner-isolation', 'newest-first', 'unique-references', 'audit', 'runtime-privileges', 'constraints'] }));
} finally {
  if (db) await db.end();
  if (created && migrated) await admin.query(`DROP DATABASE ${name} CASCADE`);
  else if (created) console.log(JSON.stringify({ preservedGeneratedDatabaseForReconciliation: name }));
  await admin.end();
}
