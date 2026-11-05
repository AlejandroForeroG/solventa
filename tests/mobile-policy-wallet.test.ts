import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuthFailure } from '../apps/mobile/src/features/authentication/domain/session';
import { ProtectedPolicyCache } from '../apps/mobile/src/features/policy-cache/application/protected-policy-cache';
import { PolicyCacheFailure } from '../apps/mobile/src/features/policy-cache/domain/cached-policy';
import type { CachedPolicy } from '../apps/mobile/src/features/policy-cache/domain/cached-policy';
import { PolicyWallet } from '../apps/mobile/src/features/policy-wallet/application/policy-wallet';
import type { PoliciesApi } from '../apps/mobile/src/features/policy-wallet/application/ports';
import { PolicyApiFailure, policyReference, validityAt } from '../apps/mobile/src/features/policy-wallet/domain/wallet';
import type { WalletSnapshot } from '../apps/mobile/src/features/policy-wallet/domain/wallet';

const owner = { clientId: '00000000-0000-4000-8000-000000000001', subjectToken: '00000000-0000-4000-8000-000000000002' };
const installation = '10000000-0000-4000-8000-000000000001';
const policy: CachedPolicy = {
  policyId: '2a1b3c4d-0000-4000-8000-000000000001', product: 'vida_hipotecario', premium: '86400.0000', currency: 'COP',
  effectiveFrom: '2026-10-16T02:00:00.000Z', effectiveUntil: '2027-10-16T02:00:00.000Z', coverage: { kind: 'mortgage_life', sumInsured: '320000000.0000' },
};

function fixture(options: { authentication?: 'pass' | 'deny' | 'no_lock'; storeWrites?: boolean } = {}) {
  let value: string | null = null;
  let clock = 1_800_000_000_000;
  const state = { prompts: 0, listCalls: 0, listing: (): Promise<{ policies: CachedPolicy[]; hasMore: boolean }> => Promise.resolve({ policies: [policy], hasMore: false }) };
  const cache = new ProtectedPolicyCache({
    store: { read: async () => value, write: async next => { if (options.storeWrites === false) throw new Error('disk full'); value = next; }, remove: async () => { value = null; } },
    installationId: async () => installation, now: () => clock,
    authentication: { authenticate: async () => {
      state.prompts++;
      if (options.authentication === 'deny') throw new PolicyCacheFailure('locked');
      if (options.authentication === 'no_lock') throw new PolicyCacheFailure('unavailable');
    } },
  });
  const api: PoliciesApi = { list: () => { state.listCalls++; return state.listing(); } };
  const wallet = new PolicyWallet({ api, cache, owner, now: () => clock });
  const states: WalletSnapshot[] = [];
  wallet.subscribe(() => states.push(wallet.getSnapshot()));
  return { wallet, cache, state, states, advance: (ms: number) => { clock += ms; }, stored: () => value };
}

test('the wallet is locked until the device authentication passes and loads nothing before that', async () => {
  const f = fixture({ authentication: 'deny' });
  assert.deepEqual(f.wallet.getSnapshot(), { status: 'locked' });
  await f.wallet.unlock();
  assert.deepEqual(f.wallet.getSnapshot(), { status: 'locked', failure: 'denied' });
  assert.equal(f.state.listCalls, 0);
  assert.equal(f.stored(), null);

  const noLock = fixture({ authentication: 'no_lock' });
  await noLock.wallet.unlock();
  assert.deepEqual(noLock.wallet.getSnapshot(), { status: 'locked', failure: 'no_device_lock' });
  assert.equal(noLock.state.listCalls, 0);
});

test('online, the wallet shows the server data as current and keeps a protected copy', async () => {
  const f = fixture();
  await f.wallet.unlock();
  assert.deepEqual(f.states.map(item => item.status), ['loading', 'ready']);
  assert.deepEqual(f.wallet.getSnapshot(), { status: 'ready', source: 'online', syncedAt: 1_800_000_000_000, policies: [policy], hasMore: false, stored: true });
  assert.ok(f.stored() && !f.stored()!.includes('vida_hipotecario'), 'the copy rests in the compact protected encoding');
});

test('without connection the wallet shows the last saved copy, labelled with its own sync time', async () => {
  const f = fixture();
  await f.wallet.unlock();
  f.advance(3_600_000);
  f.state.listing = () => Promise.reject(new PolicyApiFailure('unavailable'));
  f.wallet.lock();
  await f.wallet.unlock();
  assert.equal(f.state.prompts, 2, 'each opening asks for the device authentication again');
  assert.deepEqual(f.wallet.getSnapshot(), { status: 'ready', source: 'stored', syncedAt: 1_800_000_000_000, policies: [policy], hasMore: false, stored: true });
});

test('without connection and without a copy the wallet says so instead of showing data', async () => {
  const f = fixture();
  f.state.listing = () => Promise.reject(new PolicyApiFailure('unavailable'));
  await f.wallet.unlock();
  assert.deepEqual(f.wallet.getSnapshot(), { status: 'failed', failure: 'no_copy' });
});

test('a copy that fails to save does not hide the online data, and says it was not kept', async () => {
  const f = fixture({ storeWrites: false });
  await f.wallet.unlock();
  const snapshot = f.wallet.getSnapshot();
  assert.ok(snapshot.status === 'ready' && snapshot.source === 'online' && snapshot.stored === false);
});

test('a revoked or denied session never falls back to the stored copy', async () => {
  const f = fixture();
  await f.wallet.unlock();
  f.wallet.lock();
  f.state.listing = () => Promise.reject(new AuthFailure('unauthorized'));
  await f.wallet.unlock();
  assert.deepEqual(f.wallet.getSnapshot(), { status: 'failed', failure: 'unauthorized' });
  f.state.listing = () => Promise.reject(new Error('unexpected'));
  f.wallet.lock();
  await f.wallet.unlock();
  assert.deepEqual(f.wallet.getSnapshot(), { status: 'failed', failure: 'unavailable' });
});

test('an owner with no policies gets an empty list and an empty copy', async () => {
  const f = fixture();
  f.state.listing = () => Promise.resolve({ policies: [], hasMore: false });
  await f.wallet.unlock();
  assert.deepEqual(f.wallet.getSnapshot(), { status: 'ready', source: 'online', syncedAt: 1_800_000_000_000, policies: [], hasMore: false, stored: true });
  f.state.listing = () => Promise.reject(new PolicyApiFailure('unavailable'));
  f.wallet.lock();
  await f.wallet.unlock();
  const offline = f.wallet.getSnapshot();
  assert.ok(offline.status === 'ready' && offline.source === 'stored' && offline.policies.length === 0);
});

test('locking hides the data, locks the cache and discards a response that arrives afterwards', async () => {
  const f = fixture();
  let release: (value: { policies: CachedPolicy[]; hasMore: boolean }) => void = () => {};
  f.state.listing = () => new Promise(resolve => { release = resolve; });
  const opening = f.wallet.unlock();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.wallet.getSnapshot().status, 'loading');
  f.wallet.lock();
  release({ policies: [policy], hasMore: false });
  await opening;
  assert.deepEqual(f.wallet.getSnapshot(), { status: 'locked' });
  await assert.rejects(f.cache.read(owner), error => error instanceof PolicyCacheFailure && error.kind === 'locked');
  assert.equal(f.stored(), null, 'a response that arrives after locking is not stored');
});

test('refresh only reloads an unlocked wallet', async () => {
  const f = fixture();
  await f.wallet.refresh();
  assert.equal(f.state.listCalls, 0);
  await f.wallet.unlock();
  await f.wallet.refresh();
  assert.equal(f.state.listCalls, 2);
});

test('the policy validity follows the dates and the reference is the start of the identifier', () => {
  const at = (iso: string) => Date.parse(iso);
  assert.equal(validityAt(policy, at('2026-10-15T00:00:00.000Z')), 'upcoming');
  assert.equal(validityAt(policy, at('2026-10-16T02:00:00.000Z')), 'active');
  assert.equal(validityAt(policy, at('2027-10-16T01:59:59.999Z')), 'active');
  assert.equal(validityAt(policy, at('2027-10-16T02:00:00.000Z')), 'expired');
  assert.equal(policyReference(policy.policyId), 'POL-2A1B3C4D');
});
