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
    'SELECT status,attempts,lease_owner,lease_until,published_at,available_at,now() AS observed_at FROM identity.outbox_events WHERE event_id=$1', [id])).rows[0];
  const empty = async () => { await inspection.query('DELETE FROM identity.outbox_events'); };
  let deliveryCalls = 0;
  const publish = (deliver: Parameters<typeof publishSecurityAlerts>[0]['delivery']['deliver']) => publishSecurityAlerts({
    outbox, delivery: { deliver: async alert => { deliveryCalls++; return deliver(alert); } }, now: () => Date.now(), newId: randomUUID,
  });
  type FixtureSnapshotRow = {
    event_id: string; event_type: string; status: string; attempts: string;
    lease_owner: string | null; lease_until: Date | null; published_at: Date | null;
    available_at: Date; eligible: boolean;
  };
  const snapshot = async (): Promise<FixtureSnapshotRow[]> => (await inspection.query(`SELECT event_id,event_type,status,attempts,lease_owner,lease_until,published_at,available_at,
    (event_type IN ('identity.security_denied','identity.device_registration_denied') AND
      ((status='pending' AND available_at<=now()) OR (status='publishing' AND lease_until<=now()))) AS eligible
    FROM identity.outbox_events ORDER BY event_id`)).rows;
  async function verifyNoProgress<T>(before: Awaited<ReturnType<typeof snapshot>>, callsBefore: number, result: T, emptyResult: T) {
    const after = await snapshot();
    assert.deepEqual(result, emptyResult, 'a no-progress invocation has no acknowledged or rejected effects');
    assert.equal(deliveryCalls, callsBefore, 'an empty claim must never call the provider');
    assert.deepEqual(after.map(({ eligible: _eligible, ...stored }) => stored),
      before.map(({ eligible: _eligible, ...stored }) => stored), 'an empty claim must not change attempts or delivery state');
    return after;
  }
  async function noClaim() {
    const before = await snapshot();
    const callsBefore = deliveryCalls;
    await verifyNoProgress(before, callsBefore, await claim(), { events: [], deadLettered: 0 });
  }
  async function observeProgress<T>(operation: () => Promise<T>, progress: (value: T) => number, emptyResult: T,
    deadline = performance.now() + 2_000): Promise<T> {
    for (;;) {
      assert.ok(performance.now() < deadline, 'eligible fixture work made no progress within two seconds');
      const before = await snapshot();
      const callsBefore = deliveryCalls;
      const result = await operation();
      if (progress(result) > 0) return result;
      const after = await verifyNoProgress(before, callsBefore, result, emptyResult);
      console.log(JSON.stringify({ event: 'security_alert_smoke_no_progress', before, result, after }));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const claimProgress = (leaseOwner = randomUUID(), limit = 1, deadline?: number) => observeProgress(
    () => claim(leaseOwner, limit), batch => batch.events.length + batch.deadLettered, { events: [], deadLettered: 0 }, deadline);
  async function claimEvents(count: number, leaseOwner = randomUUID()) {
    const events: Awaited<ReturnType<typeof claim>>['events'] = [];
    const deadline = performance.now() + 2_000;
    while (events.length < count) {
      const limit = Math.min(count - events.length, securityAlertPolicy.batchSize);
      const batch = await claimProgress(leaseOwner, limit, deadline);
      assert.equal(batch.deadLettered, 0);
      assert.ok(batch.events.length <= limit);
      events.push(...batch.events);
      assert.equal(new Set(events.map(event => event.eventId)).size, events.length, 'a lease cannot be acquired twice');
    }
    return events;
  }
  const publishProgress = (deliver: Parameters<typeof publish>[0]) => observeProgress(
    () => publish(deliver), result => result.claimed + result.deadLettered,
    { claimed: 0, accepted: 0, published: 0, retried: 0, deadLettered: 0, leaseLost: 0 });

  // Rejected configuration must not acquire or mutate a durable event.
  const untouchedId = await seed();
  const untouched = await row(untouchedId);
  const validClaim = { leaseOwner: randomUUID(), limit: 1, leaseMs: securityAlertPolicy.leaseMs, maxAttempts: securityAlertPolicy.maxAttempts };
  for (const invalid of [{ leaseOwner: '' }, { limit: 0 }, { limit: securityAlertPolicy.batchSize + 1 },
    { limit: 1.5 }, { leaseMs: 1 }, { maxAttempts: 1 }]) {
    await assert.rejects(outbox.claim({ ...validClaim, ...invalid }), /^Error: invalid_security_alert_claim$/);
  }
  for (const delay of [999, 8_001, 1_000.5, NaN]) {
    await assert.rejects(outbox.failed(untouchedId, validClaim.leaseOwner, delay), /^Error: invalid_security_alert_retry$/);
  }
  const afterInvalid = await row(untouchedId);
  assert.deepEqual({ ...afterInvalid, observed_at: null }, { ...untouched, observed_at: null });
  const unavailable = new SqlSecurityAlertOutbox('postgresql://synthetic:synthetic@127.0.0.1:1/unavailable');
  await assert.rejects(unavailable.claim(validClaim), /^Error: security_alert_outbox_unavailable$/);
  await empty();

  // Concurrent independent connections must never acquire the same unexpired lease.
  const seeded = [await seed(), await seed()];
  const firstOwner = randomUUID();
  const secondOwner = randomUUID();
  const concurrent = await observeProgress(
    () => Promise.all([claim(firstOwner), claim(secondOwner)]),
    batches => batches.reduce((count, batch) => count + batch.events.length, 0),
    [{ events: [], deadLettered: 0 }, { events: [], deadLettered: 0 }]);
  assert.ok(concurrent.every(batch => batch.deadLettered === 0));
  const claims = concurrent.flatMap((batch, index) => batch.events.map(event => ({ event, owner: [firstOwner, secondOwner][index] })));
  assert.ok(claims.length >= 1 && claims.length <= 2, 'a concurrent claim must acquire an event before sequential recovery');
  assert.equal(new Set(claims.map(({ event }) => event.eventId)).size, claims.length);
  // A claim is bounded by its limit; it does not promise an immediately full batch.
  const recoveryOwner = randomUUID();
  const remaining = await claimEvents(2 - claims.length, recoveryOwner);
  claims.push(...remaining.map(event => ({ event, owner: recoveryOwner })));
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
  await noClaim();
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
  const publishing = publishProgress(async alert => { assert.equal(alert.eventId, ackId); arrived(); return providerAck; });
  await Promise.race([providerCalled, publishing.then(() => assert.fail('the provider was never called'))]);
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
    const before = await row(retryId);
    const result = await publishProgress(async alert => { delivered.push(alert.eventId); return { accepted: false, retryable: true }; });
    const stored = await row(retryId);
    assert.equal(result.claimed, 1);
    assert.equal(delivered.length, attempt);
    assert.equal(Number(stored.attempts), attempt);
    assert.equal(stored.status, attempt < 5 ? 'pending' : 'dead_letter');
    assert.equal(stored.published_at, null);
    assert.equal(result.retried, attempt < 5 ? 1 : 0);
    assert.equal(result.deadLettered, attempt === 5 ? 1 : 0);
    assert.equal(stored.lease_owner, null);
    assert.equal(stored.lease_until, null);
    if (attempt < 5) {
      const delay = 1_000 * 2 ** (attempt - 1);
      assert.ok(stored.available_at.getTime() >= before.observed_at.getTime() + delay - 1);
      assert.ok(stored.available_at.getTime() <= stored.observed_at.getTime() + delay + 1);
      await inspection.query("UPDATE identity.outbox_events SET available_at=now()+INTERVAL '1 hour' WHERE event_id=$1", [retryId]);
      await noClaim();
      await inspection.query("UPDATE identity.outbox_events SET available_at='2000-01-01T00:00:00Z' WHERE event_id=$1", [retryId]);
    }
  }
  assert.deepEqual(delivered, Array(5).fill(retryId));
  await noClaim();
  await empty();

  // Expired leases can be recovered; their former owner cannot acknowledge them.
  const recoveredId = await seed();
  const oldOwner = randomUUID();
  const newOwner = randomUUID();
  assert.equal((await claimEvents(1, oldOwner))[0].eventId, recoveredId);
  await inspection.query("UPDATE identity.outbox_events SET lease_until='2000-01-01T00:00:00Z' WHERE event_id=$1", [recoveredId]);
  assert.equal(await outbox.published(recoveredId, oldOwner), false);
  assert.equal((await claimEvents(1, newOwner))[0].attempts, 2);
  assert.equal(await outbox.failed(recoveredId, oldOwner, 1_000), false);
  assert.equal(await outbox.published(recoveredId, newOwner), true);
  await empty();

  // A publisher crash on its fifth claim becomes visible as dead letter after expiry.
  const exhaustedId = await seed('identity.security_denied', undefined, 4);
  assert.equal((await claimEvents(1))[0].attempts, 5);
  await inspection.query("UPDATE identity.outbox_events SET lease_until='2000-01-01T00:00:00Z' WHERE event_id=$1", [exhaustedId]);
  const exhausted = await claimProgress();
  assert.equal(exhausted.deadLettered, 1);
  assert.deepEqual(exhausted.events, []);
  assert.equal((await row(exhaustedId)).status, 'dead_letter');
  await empty();

  const invalidId = await seed('identity.security_denied', { arbitrary: 'synthetic-private-marker' });
  let providerCalls = 0;
  assert.equal((await publishProgress(async () => { providerCalls++; return { accepted: true }; })).deadLettered, 1);
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
  assert.equal((await publishProgress(async alert => {
    assert.equal(alert.eventId, deviceId); assert.equal(alert.decisionId, decisionId);
    assert.equal(alert.category, 'device_registration'); assert.equal(alert.cause, 'installation_replacement');
    assert.equal(JSON.stringify(alert).includes('synthetic-private-marker'), false);
    return { accepted: true };
  })).published, 1);
  await empty();

  const unrelatedId = await seed('identity.client_created');
  const boundedIds: string[] = [];
  for (let index = 0; index < 12; index++) boundedIds.push(await seed());
  const bounded = await claimEvents(10);
  assert.equal(bounded.length, 10);
  const lastBatch = await claimEvents(2);
  assert.equal(lastBatch.length, 2);
  assert.deepEqual([...bounded, ...lastBatch].map(event => event.eventId).sort(), boundedIds.sort());
  await noClaim();
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
