import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ProtectedPolicyCache } from '../apps/mobile/src/features/policy-cache/application/protected-policy-cache';
import type { ProtectedStore } from '../apps/mobile/src/features/policy-cache/application/protected-policy-cache';
import { PolicyCacheFailure, maxCachedPolicies } from '../apps/mobile/src/features/policy-cache/domain/cached-policy';

const owner = { clientId: '00000000-0000-4000-8000-000000000001', subjectToken: '00000000-0000-4000-8000-000000000002' };
const otherOwner = { ...owner, subjectToken: '00000000-0000-4000-8000-0000000000ff' };
const installation = '10000000-0000-4000-8000-000000000001';
const now = 1_800_000_000_000;

function policy(index = 1, extra: Record<string, unknown> = {}) {
  return {
    policyId: `20000000-0000-4000-8000-00000000000${index}`, offerId: '30000000-0000-4000-8000-000000000001', offerVersion: 2,
    status: 'issued', premium: '1250000.0000', currency: 'COP', effectiveFrom: '2026-11-01T00:00:00.000Z', effectiveUntil: '2027-11-01T00:00:00.000Z',
    document: 'Synthetic policy document that must stay on the server', documentHash: 'a'.repeat(64), synthetic: true, providerMode: 'mock',
    replayed: false, traceId: '40000000-0000-4000-8000-000000000001', ...extra,
  };
}

function fixture(id = installation) {
  const state = { value: null as string | null, removed: 0, installation: id };
  const store: ProtectedStore = {
    read: async () => state.value,
    write: async value => { state.value = value; },
    remove: async () => { state.value = null; state.removed++; },
  };
  const cache = new ProtectedPolicyCache({ store, installationId: async () => state.installation, now: () => now });
  return { cache, state };
}

test('only the minimum policy fields reach storage; the document, hash, offer, payment and trace data never do', async () => {
  const f = fixture();
  await f.cache.save(owner, [policy(1, { payment: { reference: 'synthetic-payment' } })]);
  const stored = f.state.value ?? '';
  for (const forbidden of ['document', 'documentHash', 'offerId', 'offerVersion', 'payment', 'traceId', 'synthetic', 'providerMode', 'Synthetic policy document']) {
    assert.ok(!stored.includes(forbidden), `${forbidden} must not be stored`);
  }
  assert.deepEqual(await f.cache.read(owner), { syncedAt: now, policies: [{
    policyId: '20000000-0000-4000-8000-000000000001', status: 'issued', premium: '1250000.0000', currency: 'COP',
    effectiveFrom: '2026-11-01T00:00:00.000Z', effectiveUntil: '2027-11-01T00:00:00.000Z',
  }] });
});

test('malformed policies are rejected before anything is written', async () => {
  const invalid = [
    policy(1, { policyId: 'not-a-uuid' }), policy(1, { status: 'cancelled' }), policy(1, { premium: '1250000' }),
    policy(1, { currency: 'USD' }), policy(1, { effectiveFrom: 'yesterday' }), null, 'policy',
  ];
  for (const source of invalid) {
    const f = fixture();
    await assert.rejects(f.cache.save(owner, [source]), error => error instanceof PolicyCacheFailure && error.kind === 'invalid_policy');
    assert.equal(f.state.value, null);
  }
  const f = fixture();
  await assert.rejects(f.cache.save({ clientId: 'x', subjectToken: 'y' }, [policy()]), error => error instanceof PolicyCacheFailure && error.kind === 'invalid_policy');
  assert.equal(f.state.value, null);
});

test('a snapshot beyond the keychain-safe size is rejected instead of written', async () => {
  const f = fixture();
  const many = Array.from({ length: maxCachedPolicies + 1 }, (_, index) => policy(index));
  await assert.rejects(f.cache.save(owner, many), error => error instanceof PolicyCacheFailure && error.kind === 'too_large');
  assert.equal(f.state.value, null);
  const largest = Array.from({ length: maxCachedPolicies }, (_, index) => policy(index, { premium: '999999999999999.0000', effectiveFrom: '2026-11-01T00:00:00.000+05:00' }));
  assert.equal((await f.cache.save(owner, largest)).policies.length, maxCachedPolicies);
  assert.ok(new TextEncoder().encode(f.state.value ?? '').length <= 1800);

  const verbose = Array.from({ length: maxCachedPolicies }, (_, index) => policy(index, { effectiveFrom: `2026-11-01T00:00:00.${'0'.repeat(200)}Z` }));
  await f.cache.clear();
  await assert.rejects(f.cache.save(owner, verbose), error => error instanceof PolicyCacheFailure && error.kind === 'too_large');
  assert.equal(f.state.value, null);
});

test('a snapshot of another owner or installation is discarded and never shown', async () => {
  const f = fixture();
  await f.cache.save(owner, [policy()]);
  assert.equal(await f.cache.read(otherOwner), null);
  assert.equal(f.state.value, null);

  await f.cache.save(owner, [policy()]);
  f.state.installation = '10000000-0000-4000-8000-000000000002';
  assert.equal(await f.cache.read(owner), null);
  assert.equal(f.state.value, null);
});

test('corrupt or tampered storage is discarded as empty', async () => {
  const f = fixture();
  for (const value of ['not json', '[]', JSON.stringify({ version: 2 })]) {
    f.state.value = value;
    assert.equal(await f.cache.read(owner), null);
    assert.equal(f.state.value, null);
  }
  await f.cache.save(owner, [policy()]);
  f.state.value = (f.state.value ?? '').replace('"issued"', '"unknown"');
  assert.equal(await f.cache.read(owner), null);
  assert.equal(f.state.value, null);
});

test('an empty cache reads as empty without removing anything', async () => {
  const f = fixture();
  assert.equal(await f.cache.read(owner), null);
  assert.equal(f.state.removed, 0);
});

test('clear removes the snapshot', async () => {
  const f = fixture();
  await f.cache.save(owner, [policy()]);
  await f.cache.clear();
  assert.equal(f.state.value, null);
});
