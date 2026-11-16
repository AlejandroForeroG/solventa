import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ProtectedPolicyCache } from '../apps/mobile/src/features/policy-cache/application/protected-policy-cache';
import type { DiscardMarker, ProtectedStore } from '../apps/mobile/src/features/policy-cache/application/protected-policy-cache';
import { PolicyCacheFailure, maxCachedPolicies, maxSnapshotBytes } from '../apps/mobile/src/features/policy-cache/domain/cached-policy';

const owner = { clientId: '00000000-0000-4000-8000-000000000001', subjectToken: '00000000-0000-4000-8000-000000000002' };
const otherOwner = { ...owner, subjectToken: '00000000-0000-4000-8000-0000000000ff' };
const installation = '10000000-0000-4000-8000-000000000001';
const now = 1_800_000_000_000;
const uuid = (index: number) => `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

function mortgage(index = 1, extra: Record<string, unknown> = {}) {
  return {
    policyId: uuid(index), offerId: '30000000-0000-4000-8000-000000000001', offerVersion: 2, product: 'vida_hipotecario', status: 'issued',
    premium: '86400.0000', currency: 'COP', effectiveFrom: '2026-10-16T02:00:00.000Z', effectiveUntil: '2027-10-16T02:00:00.000Z',
    coverage: { kind: 'mortgage_life', sumInsured: '320000000.0000' },
    document: 'Synthetic policy document that must stay on the server', documentHash: 'a'.repeat(64), synthetic: true, providerMode: 'mock',
    replayed: false, traceId: '40000000-0000-4000-8000-000000000001', ...extra,
  };
}

function flight(index = 1, extra: Record<string, unknown> = {}) {
  return { ...mortgage(index), product: 'flight_delay', premium: '999999999999999.0000',
    effectiveFrom: '2026-10-16T02:00:00.123Z', effectiveUntil: '2026-10-17T02:00:00.999Z',
    coverage: { kind: 'flight_delay', flightReference: '50000000-0000-4000-8000-000000000001', thresholdMinutes: 180, payoutAmount: '999999999999999.0000' }, ...extra };
}

function weather(index = 1, extra: Record<string, unknown> = {}) {
  return { ...mortgage(index), product: 'weather_event', premium: '999999999999999.0000',
    effectiveFrom: '2026-10-16T02:00:00.123Z', effectiveUntil: '2026-10-17T02:00:00.999Z',
    coverage: { kind: 'weather_event', stationId: '60000000-0000-4000-8000-000000000001', parameter: 'precipitation_24h', unit: 'mm', threshold: 50, payoutAmount: '999999999999999.0000' }, ...extra };
}

function fixture(passes = true) {
  const state = { value: null as string | null, removed: 0, installation, prompts: 0, passes, flag: false, removeFails: false, raiseFails: false, settleFails: false };
  const store: ProtectedStore = {
    read: async () => state.value,
    write: async value => { state.value = value; },
    remove: async () => { if (state.removeFails) throw new PolicyCacheFailure('not_removed'); state.value = null; state.removed++; },
  };
  const discard: DiscardMarker = {
    raise: async () => { if (state.raiseFails) throw new Error('marker not written'); state.flag = true; },
    pending: async () => state.flag,
    settle: async () => { if (state.settleFails) throw new PolicyCacheFailure('not_removed'); state.flag = false; },
  };
  const open = () => new ProtectedPolicyCache({ store, discard, installationId: async () => state.installation, now: () => now,
    authentication: { authenticate: async () => { state.prompts++; if (!state.passes) throw new PolicyCacheFailure('locked'); } } });
  // `restart` is a new app start over the same device storage.
  return { cache: open(), restart: open, state };
}

test('only the minimum policy fields reach storage; the document, hash, offer, payment and trace data never do', async () => {
  const f = fixture();
  await f.cache.save(owner, [mortgage(1, { payment: { reference: 'synthetic-payment' } })]);
  const stored = f.state.value ?? '';
  for (const forbidden of ['document', 'documentHash', 'offerId', 'offerVersion', 'payment', 'traceId', 'synthetic', 'providerMode', 'Synthetic policy document', 'issued']) {
    assert.ok(!stored.includes(forbidden), `${forbidden} must not be stored`);
  }
  await f.cache.unlock();
  assert.deepEqual(await f.cache.read(owner), { syncedAt: now, policies: [{
    policyId: uuid(1), product: 'vida_hipotecario', premium: '86400.0000', currency: 'COP',
    effectiveFrom: '2026-10-16T02:00:00.000Z', effectiveUntil: '2027-10-16T02:00:00.000Z',
    coverage: { kind: 'mortgage_life', sumInsured: '320000000.0000' },
  }] });
});

test('every product survives the compact encoding exactly, including millisecond instants', async () => {
  const f = fixture();
  const saved = await f.cache.save(owner, [mortgage(1), flight(2), weather(3)]);
  await f.cache.unlock();
  assert.deepEqual(await f.cache.read(owner), saved);
  assert.equal(saved.policies[1].effectiveUntil, '2026-10-17T02:00:00.999Z');
  assert.deepEqual(saved.policies[1].coverage, flight().coverage);
  assert.deepEqual(saved.policies[2].coverage, weather().coverage);
  assert.equal(saved.policies[2].product, 'weather_event');
});

test('malformed policies are rejected before anything is written', async () => {
  const invalid = [
    mortgage(1, { policyId: 'not-a-uuid' }), mortgage(1, { product: 'life' }), mortgage(1, { premium: '86400' }), mortgage(1, { currency: 'USD' }),
    mortgage(1, { effectiveFrom: 'yesterday' }), mortgage(1, { effectiveFrom: '2026-10-16T02:00:00Z' }), mortgage(1, { effectiveFrom: '2026-10-16T02:00:00.000+05:00' }),
    mortgage(1, { coverage: { kind: 'flight_delay', flightReference: uuid(9), thresholdMinutes: 1, payoutAmount: '1.0000' } }),
    mortgage(1, { coverage: { kind: 'mortgage_life', sumInsured: '1' } }), mortgage(1, { coverage: null }),
    flight(1, { coverage: { kind: 'flight_delay', flightReference: 'x', thresholdMinutes: 180, payoutAmount: '1.0000' } }),
    flight(1, { coverage: { kind: 'flight_delay', flightReference: uuid(9), thresholdMinutes: 0, payoutAmount: '1.0000' } }),
    flight(1, { coverage: { kind: 'flight_delay', flightReference: uuid(9), thresholdMinutes: 1.5, payoutAmount: '1.0000' } }),
    weather(1, { coverage: { ...weather().coverage, stationId: 'station-7' } }), weather(1, { coverage: { ...weather().coverage, threshold: 0 } }),
    weather(1, { coverage: { ...weather().coverage, threshold: 49.5 } }), weather(1, { coverage: { ...weather().coverage, unit: 'cm' } }),
    weather(1, { coverage: { ...weather().coverage, parameter: 'wind' } }), weather(1, { coverage: { ...weather().coverage, payoutAmount: '1' } }),
    weather(1, { coverage: flight().coverage }), flight(1, { coverage: weather().coverage }),
    null, 'policy',
  ];
  for (const source of invalid) {
    const f = fixture();
    await assert.rejects(f.cache.save(owner, [source]), error => error instanceof PolicyCacheFailure && error.kind === 'invalid_policy');
    assert.equal(f.state.value, null);
  }
  const f = fixture();
  await assert.rejects(f.cache.save({ clientId: 'x', subjectToken: 'y' }, [mortgage()]), error => error instanceof PolicyCacheFailure && error.kind === 'invalid_policy');
  assert.equal(f.state.value, null);
});

test('the largest allowed snapshot fits the keychain bound and one more policy is rejected', async () => {
  const f = fixture();
  const largest = Array.from({ length: maxCachedPolicies }, (_, index) => index % 2 ? weather(index + 1) : flight(index + 1));
  const saved = await f.cache.save(owner, largest);
  assert.equal(saved.policies.length, maxCachedPolicies);
  assert.ok(new TextEncoder().encode(f.state.value ?? '').length <= maxSnapshotBytes, `${f.state.value?.length} bytes`);
  await f.cache.clear();
  await assert.rejects(f.cache.save(owner, [...largest, flight(7)]), error => error instanceof PolicyCacheFailure && error.kind === 'too_large');
  assert.equal(f.state.value, null);
});

test('reading needs the device authentication on each opening and locks again afterwards', async () => {
  const f = fixture();
  await f.cache.save(owner, [mortgage()]);
  await assert.rejects(f.cache.read(owner), error => error instanceof PolicyCacheFailure && error.kind === 'locked');
  assert.equal(f.state.prompts, 0);
  await f.cache.unlock();
  assert.equal(f.state.prompts, 1);
  assert.equal((await f.cache.read(owner))?.policies.length, 1);
  f.cache.lock();
  await assert.rejects(f.cache.read(owner), error => error instanceof PolicyCacheFailure && error.kind === 'locked');
  await f.cache.unlock();
  await f.cache.clear();
  await assert.rejects(f.cache.read(owner), error => error instanceof PolicyCacheFailure && error.kind === 'locked', 'clearing also locks');
});

test('the copy of the last verified owner can be read without knowing the owner, behind the same unlock', async () => {
  const f = fixture();
  await f.cache.save(owner, [mortgage(), flight(2)]);
  await assert.rejects(f.cache.readLatest(), error => error instanceof PolicyCacheFailure && error.kind === 'locked');
  await f.cache.unlock();
  const latest = await f.cache.readLatest();
  assert.deepEqual(latest?.owner, owner);
  assert.equal(latest?.snapshot.policies.length, 2);
  f.state.installation = '10000000-0000-4000-8000-000000000002';
  assert.equal(await f.cache.readLatest(), null, 'a copy of another installation is discarded');
  assert.equal(f.state.value, null);
  assert.equal(await f.cache.readLatest(), null);
});

test('a failed or cancelled device authentication leaves the cache locked', async () => {
  const f = fixture(false);
  await f.cache.save(owner, [mortgage()]);
  await assert.rejects(f.cache.unlock(), error => error instanceof PolicyCacheFailure && error.kind === 'locked');
  await assert.rejects(f.cache.read(owner), error => error instanceof PolicyCacheFailure && error.kind === 'locked');
});

test('a snapshot of another owner or installation is discarded and never shown', async () => {
  const f = fixture();
  await f.cache.unlock();
  await f.cache.save(owner, [mortgage()]);
  assert.equal(await f.cache.read(otherOwner), null);
  assert.equal(f.state.value, null);

  await f.cache.save(owner, [mortgage()]);
  f.state.installation = '10000000-0000-4000-8000-000000000002';
  assert.equal(await f.cache.read(owner), null);
  assert.equal(f.state.value, null);
});

test('corrupt or tampered storage is discarded as empty', async () => {
  const f = fixture();
  await f.cache.unlock();
  for (const value of ['not json', '[]', JSON.stringify({ v: 1 }), JSON.stringify({ v: 2, i: installation, o: [owner.clientId, owner.subjectToken], t: 'now', p: [] })]) {
    f.state.value = value;
    assert.equal(await f.cache.read(owner), null);
    assert.equal(f.state.value, null);
  }
  await f.cache.save(owner, [mortgage()]);
  f.state.value = (f.state.value ?? '').replace(',0,', ',7,');
  assert.equal(await f.cache.read(owner), null);
  assert.equal(f.state.value, null);
});

test('an empty cache reads as empty without removing anything, and an empty list is a valid snapshot', async () => {
  const f = fixture();
  await f.cache.unlock();
  assert.equal(await f.cache.read(owner), null);
  assert.equal(f.state.removed, 0);
  await f.cache.save(owner, []);
  assert.deepEqual(await f.cache.read(owner), { syncedAt: now, policies: [] });
});

test('a clear that starts while a save is writing runs after it, so no data outlives the session', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let value: string | null = null;
  const cache = new ProtectedPolicyCache({
    store: { read: async () => value, write: async next => { await gate; value = next; }, remove: async () => { value = null; } },
    discard: { raise: async () => {}, pending: async () => false, settle: async () => {} },
    installationId: async () => installation, now: () => now, authentication: { authenticate: async () => {} },
  });
  const saving = cache.save(owner, [mortgage()]);
  const clearing = cache.clear();
  release();
  await Promise.all([saving, clearing]);
  assert.equal(value, null, 'the write finished first and the removal ran after it');
  await assert.rejects(cache.read(owner), error => error instanceof PolicyCacheFailure && error.kind === 'locked');
});

test('a failed save does not block later operations and a read never runs ahead of a pending clear', async () => {
  const f = fixture();
  await assert.rejects(f.cache.save(owner, [mortgage(1, { premium: 'free' })]), error => error instanceof PolicyCacheFailure);
  await f.cache.save(owner, [mortgage()]);
  await f.cache.unlock();
  const clearing = f.cache.clear();
  const reading = f.cache.read(owner);
  await clearing;
  await assert.rejects(reading, error => error instanceof PolicyCacheFailure && error.kind === 'locked');
  assert.equal(f.state.value, null);
});

test('a removal that fails keeps the copy closed across retries and restarts until it succeeds', async () => {
  const f = fixture();
  await f.cache.save(owner, [mortgage()]);
  await f.cache.unlock();
  f.state.removeFails = true;
  await assert.rejects(f.cache.clear(), error => error instanceof PolicyCacheFailure && error.kind === 'not_removed');
  assert.equal(f.state.flag, true, 'the owed removal is recorded before it is attempted');
  assert.ok(f.state.value, 'the copy is still there, which is why it must stay closed');

  // An app start, with or without connection, must not reopen it.
  for (const cache of [f.cache, f.restart(), f.restart()]) {
    await cache.unlock();
    await assert.rejects(cache.readLatest(), error => error instanceof PolicyCacheFailure && error.kind === 'not_removed');
    await assert.rejects(cache.read(owner), error => error instanceof PolicyCacheFailure && error.kind === 'not_removed');
    await assert.rejects(cache.save(owner, [mortgage(2)]), error => error instanceof PolicyCacheFailure && error.kind === 'not_removed');
  }
  assert.ok(f.state.value?.includes(uuid(1)), 'nothing was replaced while the removal was owed');

  f.state.removeFails = false;
  const restarted = f.restart();
  await restarted.unlock();
  assert.equal(await restarted.readLatest(), null, 'the next opening finishes the removal instead of showing the copy');
  assert.equal(f.state.value, null);
  assert.equal(f.state.flag, false);
  await restarted.save(owner, [mortgage(3)]);
  assert.equal((await restarted.readLatest())?.snapshot.policies.length, 1);
});

test('a successful clear leaves no owed removal, and the note failing to write does not block the removal', async () => {
  const f = fixture();
  await f.cache.save(owner, [mortgage()]);
  await f.cache.clear();
  assert.equal(f.state.flag, false);
  assert.equal(f.state.value, null);

  await f.cache.save(owner, [mortgage()]);
  f.state.raiseFails = true;
  await f.cache.clear();
  assert.equal(f.state.value, null, 'the removal still ran');
  assert.equal(f.state.flag, false);
});

test('when both the note and the removal fail the clear reports the failure', async () => {
  const f = fixture();
  await f.cache.save(owner, [mortgage()]);
  f.state.raiseFails = true;
  f.state.removeFails = true;
  await assert.rejects(f.cache.clear(), error => error instanceof PolicyCacheFailure && error.kind === 'not_removed');
});

test('a note that cannot be settled keeps the cache closed, so a fresh snapshot is never removed by a stale note', async () => {
  const f = fixture();
  await f.cache.save(owner, [mortgage()]);
  f.state.settleFails = true;
  await assert.rejects(f.cache.clear(), error => error instanceof PolicyCacheFailure && error.kind === 'not_removed');
  assert.equal(f.state.value, null, 'the copy itself was removed');
  assert.equal(f.state.flag, true, 'the debt is still recorded');
  await assert.rejects(f.cache.save(owner, [mortgage(2)]), error => error instanceof PolicyCacheFailure && error.kind === 'not_removed');
  assert.equal(f.state.value, null, 'nothing new is stored while the note is stuck');

  f.state.settleFails = false;
  await f.cache.save(owner, [mortgage(3)]);
  await f.cache.unlock();
  assert.equal((await f.cache.readLatest())?.snapshot.policies.length, 1, 'once settled, the new snapshot survives later reads');
});
