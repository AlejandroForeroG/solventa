import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { settings, clientFor, owners, applyMigrations, applyRuntimeGrants } from './database.mjs';
import { securityDecision } from '../backend/identity-consent-ecosystem/src/domain/security-decision';
import { publishSecurityAlerts, securityAlertPolicy } from '../backend/identity-consent-ecosystem/src/application/security-alerts';
import { SqlSecurityAlertOutbox } from '../backend/identity-consent-ecosystem/src/adapters/outbound/security-alert-outbox';

const config = await settings('local');
const name = 'solventa_security_alert_test_' + randomUUID().replaceAll('-', '');
assert.match(name, /^solventa_security_alert_test_[a-f0-9]{32}$/);
const admin = clientFor(config.url, config.ssl);
let created = false;
let db;
let runtimeDb;
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  created = true;
  const url = new URL(config.url);
  url.pathname = '/' + name;
  db = clientFor(url, config.ssl);
  await db.connect();
  await db.query('CREATE SCHEMA identity');
  await db.query('CREATE TABLE identity.schema_migrations (version STRING PRIMARY KEY, checksum STRING NOT NULL, applied_at TIMESTAMPTZ DEFAULT now())');
  const owner = owners.find(candidate => candidate.schema === 'identity');
  assert.ok(owner);
  await applyMigrations(db, owner);
  const state = JSON.parse(await readFile('infra/.local/runtime.local.json', 'utf8'));
  await db.query(`GRANT CONNECT ON DATABASE ${name} TO solventa_local_identity`);
  await db.query('GRANT USAGE ON SCHEMA identity TO solventa_local_identity');
  await applyRuntimeGrants(db, owner, 'solventa_local_identity', JSON.parse(await readFile('backend/identity-consent-ecosystem/runtime-grants.json', 'utf8')));
  const runtime = new URL(url);
  runtime.username = 'solventa_local_identity';
  runtime.password = state.passwords.identity;
  runtimeDb = clientFor(runtime, { ca: config.ssl.ca, rejectUnauthorized: true });
  await runtimeDb.connect();
  runtime.searchParams.set('sslmode', 'verify-full');
  runtime.searchParams.set('sslrootcert', 'infra/.local/certs/ca.crt');
  const outbox = new SqlSecurityAlertOutbox(runtime.toString());
  const claim = (leaseOwner = randomUUID(), limit = 1) => outbox.claim({ leaseOwner, limit,
    leaseMs: securityAlertPolicy.leaseMs, maxAttempts: securityAlertPolicy.maxAttempts });
  const runtimeConnection = runtimeDb;
  const inspection = db;
  async function seed(eventType = 'identity.security_denied', payload?: unknown, attempts = 0) {
    const id = randomUUID();
    const traceId = randomUUID();
    const decision = securityDecision({ category: 'api_access', channel: 'partner', operation: 'quotes:create', cause: 'forbidden' }, id, traceId);
    await runtimeConnection.query(
      `INSERT INTO identity.outbox_events
       (event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id,attempts)
       VALUES ($1,'security_decision',$1,$2,1,$3,$4,$5)`, [id, eventType, JSON.stringify(payload ?? decision), traceId, attempts]);
    return id;
  }
  const row = async (id: string) => (await inspection.query(
    'SELECT status,attempts,lease_owner,lease_until,published_at,available_at FROM identity.outbox_events WHERE event_id=$1', [id])).rows[0];
  const empty = async () => { await inspection.query('DELETE FROM identity.outbox_events'); };
  const publish = (deliver: Parameters<typeof publishSecurityAlerts>[0]['delivery']['deliver']) => publishSecurityAlerts({
    outbox, delivery: { deliver }, now: () => Date.now(), newId: randomUUID,
  });

  // Concurrent independent connections must never acquire the same unexpired lease.
  const seeded = [await seed(), await seed()];
  const firstOwner = randomUUID();
  const secondOwner = randomUUID();
  const concurrent = await Promise.all([claim(firstOwner), claim(secondOwner)]);
  const claims = concurrent.flatMap((batch, index) => batch.events.map(event => ({ event, owner: [firstOwner, secondOwner][index] })));
  assert.ok(claims.length >= 1 && claims.length <= 2);
  assert.equal(new Set(claims.map(({ event }) => event.eventId)).size, claims.length);
  // SKIP LOCKED may defer an available row under contention; only exclusivity, not
  // a full batch from each competing statement, is required for safe delivery.
  const recoveryOwner = randomUUID();
  const remaining = await claim(recoveryOwner, 2);
  claims.push(...remaining.events.map(event => ({ event, owner: recoveryOwner })));
  assert.equal(claims.length, 2);
  assert.equal(new Set(claims.map(({ event }) => event.eventId)).size, 2);
  assert.deepEqual(claims.map(({ event }) => event.eventId).sort(), seeded.sort());
  for (const { event, owner } of claims) {
    const stored = await row(event.eventId);
    assert.equal(stored.status, 'publishing');
    assert.equal(stored.lease_owner, owner);
    assert.equal(Number(stored.attempts), 1);
    assert.ok(stored.lease_until.getTime() > Date.now());
  }
  assert.equal((await claim()).events.length, 0);
  const first = claims[0].event;
  assert.equal(await outbox.published(first.eventId, randomUUID()), false);
  assert.equal(await outbox.published(first.eventId, claims[0].owner), true);
  assert.equal((await row(first.eventId)).status, 'published');
  assert.ok((await row(first.eventId)).published_at);
  await empty();

  // No mark-published is allowed before the external provider accepts the event.
  const ackId = await seed();
  let acknowledge: (value: { accepted: true }) => void = () => {};
  let arrived = () => {};
  const providerCalled = new Promise<void>(resolve => { arrived = resolve; });
  const providerAck = new Promise<{ accepted: true }>(resolve => { acknowledge = resolve; });
  const publishing = publish(async alert => { assert.equal(alert.eventId, ackId); arrived(); return providerAck; });
  await providerCalled;
  assert.equal((await row(ackId)).status, 'publishing');
  assert.equal((await row(ackId)).published_at, null);
  acknowledge({ accepted: true });
  assert.equal((await publishing).published, 1);
  assert.equal((await row(ackId)).status, 'published');
  await empty();

  // Failed attempts remain pending with stable eventId and bounded retry delays.
  const retryId = await seed();
  const delivered: string[] = [];
  for (let attempt = 1; attempt <= securityAlertPolicy.maxAttempts; attempt++) {
    const result = await publish(async alert => { delivered.push(alert.eventId); return { accepted: false, retryable: true }; });
    const stored = await row(retryId);
    assert.equal(Number(stored.attempts), attempt);
    assert.equal(stored.status, attempt < 5 ? 'pending' : 'dead_letter');
    assert.equal(stored.published_at, null);
    assert.equal(result.retried, attempt < 5 ? 1 : 0);
    assert.equal(result.deadLettered, attempt === 5 ? 1 : 0);
    assert.equal(stored.lease_owner, null);
    assert.equal(stored.lease_until, null);
    if (attempt < 5) {
      assert.ok(stored.available_at.getTime() > Date.now() - 1_000);
      assert.equal((await claim()).events.length, 0);
      await inspection.query("UPDATE identity.outbox_events SET available_at=now()-INTERVAL '1 second' WHERE event_id=$1", [retryId]);
    }
  }
  assert.deepEqual(delivered, Array(5).fill(retryId));
  assert.equal((await claim()).events.length, 0);
  await empty();

  // Expired leases can be recovered; their former owner cannot acknowledge them.
  const recoveredId = await seed();
  const oldOwner = randomUUID();
  const newOwner = randomUUID();
  assert.equal((await claim(oldOwner)).events[0].eventId, recoveredId);
  await inspection.query("UPDATE identity.outbox_events SET lease_until=now()-INTERVAL '1 second' WHERE event_id=$1", [recoveredId]);
  assert.equal(await outbox.published(recoveredId, oldOwner), false);
  assert.equal((await claim(newOwner)).events[0].attempts, 2);
  assert.equal(await outbox.failed(recoveredId, oldOwner, 1_000), false);
  assert.equal(await outbox.published(recoveredId, newOwner), true);
  await empty();

  // A publisher crash on its fifth claim becomes visible as dead letter after expiry.
  const exhaustedId = await seed('identity.security_denied', undefined, 4);
  assert.equal((await claim()).events[0].attempts, 5);
  await inspection.query("UPDATE identity.outbox_events SET lease_until=now()-INTERVAL '1 second' WHERE event_id=$1", [exhaustedId]);
  const exhausted = await claim();
  assert.equal(exhausted.deadLettered, 1);
  assert.deepEqual(exhausted.events, []);
  assert.equal((await row(exhaustedId)).status, 'dead_letter');
  await empty();

  const invalidId = await seed('identity.security_denied', { arbitrary: 'synthetic-private-marker' });
  let providerCalls = 0;
  assert.equal((await publish(async () => { providerCalls++; return { accepted: true }; })).deadLettered, 1);
  assert.equal(providerCalls, 0);
  assert.equal((await row(invalidId)).status, 'dead_letter');
  await empty();

  // Existing device registration denials need no duplicate business audit/outbox event.
  const deviceId = randomUUID();
  const decisionId = randomUUID();
  const traceId = randomUUID();
  await runtimeConnection.query(
    `INSERT INTO identity.outbox_events
     (event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id)
     VALUES ($1,'device_registration',$2,'identity.device_registration_denied',1,$3,$4)`,
    [deviceId, decisionId, JSON.stringify({ decisionId, action: 'registration_denied', sessionBound: true,
      capture: { schemaVersion: 1, correlationId: traceId, outcome: 'installation_replacement', inputs: { privateMarker: 'synthetic-private-marker' } } }), traceId]);
  assert.equal((await publish(async alert => {
    assert.equal(alert.eventId, deviceId); assert.equal(alert.decisionId, decisionId);
    assert.equal(alert.category, 'device_registration'); assert.equal(alert.cause, 'installation_replacement');
    assert.equal(JSON.stringify(alert).includes('synthetic-private-marker'), false);
    return { accepted: true };
  })).published, 1);
  await empty();

  const unrelatedId = await seed('identity.client_created');
  for (let index = 0; index < 12; index++) await seed();
  const bounded = await claim(randomUUID(), 10);
  assert.equal(bounded.events.length, 10);
  assert.equal((await claim(randomUUID(), 10)).events.length, 2);
  assert.equal((await row(unrelatedId)).status, 'pending');
  assert.equal(Number((await row(unrelatedId)).attempts), 0);
  await assert.rejects(outbox.claim({ leaseOwner: randomUUID(), limit: 11, leaseMs: 60_000, maxAttempts: 5 }), /invalid_security_alert_claim/);
  await assert.rejects(runtimeConnection.query('UPDATE identity.audit_events SET outcome=outcome'), { code: '42501' });
  console.log(JSON.stringify({ securityAlertsSQL: 'passed', checks: [
    'runtime_owner_grants', 'concurrent_exclusive_claim', 'provider_ack_before_published', 'stable_event_id_retry',
    'five_attempt_limit', 'expired_lease_recovery', 'stale_owner_rejected', 'crashed_last_attempt_dead_letter',
    'invalid_payload_quarantined', 'device_denial_projection', 'batch_limit_ten', 'unrelated_outbox_untouched', 'audit_immutable_runtime',
  ], delivery: 'synthetic provider acceptance only; no external email sent' }));
} finally {
  await runtimeDb?.end();
  await db?.end();
  if (created) await admin.query(`DROP DATABASE ${name} CASCADE`);
  await admin.end();
}
