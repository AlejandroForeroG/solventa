import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { RegisteredDevices } from '../backend/identity-consent-ecosystem/src/application/registered-devices';
import type { DeviceSnapshot } from '../backend/identity-consent-ecosystem/src/domain/registered-device';
import { InMemoryDeviceStore } from './support/registered-device-store';

const now = Date.parse('2026-10-14T12:00:00Z');
const installationId = '00000000-0000-4000-8000-000000000003';
const otherInstallation = '00000000-0000-4000-8000-000000000005';
const input = { identity: { providerSubject: 'user_synthetic', sessionReference: 'session_synthetic', emailVerified: true },
  installationId, correlationId: '00000000-0000-4000-8000-000000000006' };
const snapshot = (): DeviceSnapshot => ({ observedAt: now, session: { createdAt: now - 60_000, expiresAt: now + 60_000, revoked: false }, bindings: [] });
const validateCapture = new Ajv().compile(JSON.parse(readFileSync('packages/contracts/schemas/decision-capture.v1.json', 'utf8')));

for (const age of [599_999, 600_000, 600_001]) {
  test(`the core enforces the registration window at age ${age}ms with an in-memory adapter`, async () => {
    const state = snapshot(); assert.ok(state.session); state.session.createdAt = now - age;
    const store = new InMemoryDeviceStore(state);
    const result = await new RegisteredDevices(store).execute('register', input);
    assert.equal(result?.status ?? null, age < 600_000 ? 'active' : null);
    assert.equal(store.snapshot.bindings.length, age < 600_000 ? 1 : 0);
    const plan = store.plans[0];
    assert.ok(validateCapture(plan.capture), JSON.stringify(validateCapture.errors));
    assert.equal(plan.capture.inputs.session?.createdAt, now - age);
    assert.equal(plan.capture.inputs.evaluatedAt, new Date(now).toISOString());
    assert.equal(plan.capture.inputs.registrationWindowMs, 600_000);
    if (age >= 600_000) {
      assert.deepEqual(plan.decision, { effect: 'deny', reason: 'registration_window_expired', record: true });
      assert.equal(plan.capture.outcome, 'registration_window_expired');
    }
  });
}

test('an active binding replays after the registration window without replacement or duplicate registration', async () => {
  const store = new InMemoryDeviceStore(snapshot());
  const app = new RegisteredDevices(store);
  const original = await app.execute('register', input);
  store.snapshot.observedAt += 660_000;
  assert.ok(store.snapshot.session); store.snapshot.session.expiresAt = store.snapshot.observedAt + 60_000;
  assert.deepEqual(await app.execute('register', input), original);
  assert.equal(store.snapshot.bindings.length, 1);
  assert.equal(store.plans.at(-1)?.decision.effect, 'none');
});

test('the core denies replacement and captures the existing installation and actual rule inputs', async () => {
  const store = new InMemoryDeviceStore(snapshot());
  const app = new RegisteredDevices(store);
  await app.execute('register', input);
  assert.equal(await app.execute('register', { ...input, installationId: otherInstallation }), null);
  const plan = store.plans.at(-1); assert.ok(plan);
  assert.deepEqual(plan.decision, { effect: 'deny', reason: 'installation_replacement', record: true });
  assert.equal(plan.capture.outcome, 'installation_replacement');
  assert.deepEqual(plan.capture.inputs.bindings, store.snapshot.bindings);
  assert.equal(plan.capture.correlationId, input.correlationId);
  assert.equal(store.snapshot.bindings.length, 1);
});

test('a revoked binding cannot reactivate even when its owned session is fresh and active', async () => {
  const state = snapshot();
  state.bindings.push({ id: '00000000-0000-4000-8000-000000000004', installationId, revoked: true });
  const store = new InMemoryDeviceStore(state);
  assert.equal(await new RegisteredDevices(store).execute('register', input), null);
  assert.deepEqual(store.plans[0].decision, { effect: 'deny', reason: 'binding_revoked', record: true });
  assert.equal(store.snapshot.bindings[0].revoked, true);
});

test('missing, expired and revoked sessions fail closed without claiming a registration decision', async () => {
  for (const session of [null, { createdAt: now - 60_000, expiresAt: now, revoked: false }, { createdAt: now - 60_000, expiresAt: now + 60_000, revoked: true }]) {
    const store = new InMemoryDeviceStore({ ...snapshot(), session });
    assert.equal(await new RegisteredDevices(store).execute('register', input), null);
    assert.deepEqual(store.plans[0].decision, { effect: 'deny', reason: 'session_unavailable', record: false });
    assert.equal(store.snapshot.bindings.length, 0);
  }
});

test('read never registers and owned revocation remains replay-safe after local session expiry', async () => {
  const store = new InMemoryDeviceStore(snapshot());
  const app = new RegisteredDevices(store);
  assert.equal(await app.execute('find', input), null);
  await app.execute('register', input);
  const registeredAt = store.snapshot.session?.createdAt;
  assert.equal((await app.execute('find', input))?.status, 'active');
  assert.ok(store.snapshot.session); store.snapshot.session.expiresAt = now;
  assert.equal((await app.execute('revoke', input))?.status, 'revoked');
  assert.equal(store.snapshot.session.revoked, true);
  assert.equal((await app.execute('revoke', input))?.status, 'revoked');
  assert.equal(store.plans.at(-1)?.decision.effect, 'none');
  assert.equal(await app.execute('register', input), null);
  assert.equal(store.snapshot.session.createdAt, registeredAt);
});

test('invalid IDs and unverified or incomplete identities never reach the device store', async () => {
  const store = new InMemoryDeviceStore(snapshot());
  const app = new RegisteredDevices(store);
  for (const supplied of [
    { ...input, installationId: 'invalid' },
    { ...input, installationId: input.installationId + '\n' },
    { ...input, identity: { ...input.identity, emailVerified: false } },
    { ...input, identity: { ...input.identity, providerSubject: '' } },
    { ...input, identity: { ...input.identity, sessionReference: '' } },
  ]) assert.equal(await app.execute('register', supplied), null);
  assert.equal(store.calls, 0);
});

test('a required denial record failure propagates and preserves the existing binding', async () => {
  const store = new InMemoryDeviceStore(snapshot());
  const app = new RegisteredDevices(store);
  await app.execute('register', input);
  store.failRecord = true;
  await assert.rejects(app.execute('register', { ...input, installationId: otherInstallation }), /record_unavailable/);
  assert.equal(store.snapshot.bindings.length, 1);
  assert.equal(store.plans.length, 1);
});

test('UUID case variants register and replay one canonical binding without a replacement decision', async () => {
  const upper = 'ABCDEF12-3456-4789-8ABC-DEF012345678';
  const store = new InMemoryDeviceStore(snapshot());
  const app = new RegisteredDevices(store);
  const supplied = { ...input, installationId: upper, correlationId: upper };
  const original = await app.execute('register', supplied);
  assert.equal(original?.installationId, upper.toLowerCase());
  assert.deepEqual(await app.execute('register', { ...supplied, installationId: upper.toLowerCase() }), original);
  assert.equal(store.snapshot.bindings.length, 1);
  assert.equal(store.snapshot.bindings[0].installationId, upper.toLowerCase());
  assert.equal(store.plans.at(-1)?.decision.effect, 'none');
  assert.equal(store.plans[0].capture.correlationId, upper.toLowerCase());
  assert.equal(store.plans[0].capture.rule.version, '2');
  assert.ok(validateCapture(store.plans[0].capture), JSON.stringify(validateCapture.errors));
});

test('legacy uppercase binding references remain readable, replay-safe and revocable through lowercase UUIDs', async () => {
  const upper = 'ABCDEF12-3456-4789-8ABC-DEF012345678';
  const state = snapshot();
  const id = '00000000-0000-4000-8000-000000000008';
  state.bindings.push({ id, installationId: upper, revoked: false });
  const store = new InMemoryDeviceStore(state);
  const app = new RegisteredDevices(store);
  const supplied = { ...input, installationId: upper.toLowerCase() };
  assert.deepEqual(await app.execute('register', supplied), { id, installationId: upper.toLowerCase(), status: 'active' });
  assert.equal(store.plans[0].capture.inputs.bindings[0].installationId, upper.toLowerCase());
  assert.equal(store.snapshot.bindings[0].installationId, upper);
  assert.equal((await app.execute('find', { ...supplied, installationId: upper }))?.installationId, upper.toLowerCase());
  assert.equal((await app.execute('revoke', supplied))?.status, 'revoked');
  assert.equal(store.snapshot.bindings.length, 1);
  assert.equal(store.snapshot.bindings[0].revoked, true);
  assert.ok(store.plans.every(plan => plan.decision.effect !== 'deny'));
});
