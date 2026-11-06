import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Authentication } from '../apps/mobile/src/features/authentication/application/authentication';
import type { AuthBrowser, IdentityProvider, SessionApi, TokenStore } from '../apps/mobile/src/features/authentication/application/ports';
import { AuthFailure } from '../apps/mobile/src/features/authentication/domain/session';
import type { AuthRecord, Configuration } from '../apps/mobile/src/features/authentication/domain/session';
import { parseCallback } from '../apps/mobile/src/features/authentication/adapters/callback';
import { ProtectedPolicyCache } from '../apps/mobile/src/features/policy-cache/application/protected-policy-cache';
import { PolicyWallet } from '../apps/mobile/src/features/policy-wallet/application/policy-wallet';
import { createPoliciesApi } from '../apps/mobile/src/features/policy-wallet/adapters/policies-api';
import { walletAccessFor } from '../apps/mobile/src/features/policy-wallet/domain/wallet';

const baseUrl = 'https://solventa-web-staging.ja-forerog1.workers.dev';
const config: Configuration = {
  clientId: 'client_01M47F209CBGBJGD73ZM39ADW6', redirectUri: 'solventa://auth/callback',
  authorizationEndpoint: 'https://api.workos.com/user_management/authorize', tokenEndpoint: 'https://api.workos.com/user_management/authenticate',
};
const principal = { clientId: '00000000-0000-4000-8000-000000000001', subjectToken: '00000000-0000-4000-8000-000000000002' };
const installation = '10000000-0000-4000-8000-000000000001';
const traceId = '00000000-0000-4000-8000-000000000009';
const now = 1_800_000_000_000;
const policy = {
  policyId: '20000000-0000-4000-8000-000000000001', product: 'vida_hipotecario', status: 'issued', premium: '86400.0000', currency: 'COP',
  effectiveFrom: '2026-10-16T02:00:00.000Z', effectiveUntil: '2027-10-16T02:00:00.000Z', coverage: { kind: 'mortgage_life', sumInsured: '320000000.0000' },
};
const activeSession: AuthRecord = { version: 1, transaction: null, session: { configuration: config, baseUrl, phase: 'active',
  tokens: { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: now + 3_600_000 } } };

// The device: one protected store and one token store shared by every app start, like the real keychain.
function device() {
  let copy: string | null = null;
  let saved: AuthRecord = structuredClone(activeSession);
  const cache = new ProtectedPolicyCache({
    store: { read: async () => copy, write: async value => { copy = value; }, remove: async () => { copy = null; } },
    installationId: async () => installation, now: () => now, authentication: { authenticate: async () => {} },
  });
  const tokens: TokenStore = { read: async () => structuredClone(saved), write: async record => { saved = structuredClone(record); } };
  const identity: IdentityProvider = { authorize: async () => { throw new Error('not used'); }, exchange: async () => { throw new Error('not used'); }, refresh: async () => { throw new Error('not used'); } };
  const browser: AuthBrowser = { assertAvailable: () => {}, open: async () => null };
  const start = (inspect: () => Promise<typeof principal>) => {
    const api: SessionApi = {
      configuration: async () => config, register: async () => principal, inspect, access: async () => principal, logout: async () => {},
      registerDevice: async () => {}, inspectDevice: async () => {}, revokeDevice: async () => {},
    };
    return new Authentication({ baseUrl, store: tokens, identity, api, browser, now: () => now, parseCallback, policyCache: cache });
  };
  return { cache, start };
}

const outage = () => Promise.reject(new AuthFailure('unavailable'));
const revoked = () => Promise.reject(new AuthFailure('unauthorized'));
const verified = async () => principal;

function walletFor(auth: Authentication, cache: ProtectedPolicyCache, respond: () => Response | Promise<Response>) {
  const access = walletAccessFor(auth.getSnapshot());
  assert.ok(access, `no wallet access in state ${auth.getSnapshot().status}`);
  const calls = { fetch: 0 };
  const api = createPoliciesApi(baseUrl, { execute: operation => operation('synthetic-access') }, (async () => { calls.fetch++; return respond(); }) as unknown as typeof fetch);
  return { access, calls, wallet: new PolicyWallet({ api, cache, owner: access.mode === 'online' ? access.owner : undefined, now: () => now }) };
}
const ok = () => new Response(JSON.stringify({ policies: [policy], hasMore: false, traceId }), { status: 200, headers: { 'content-type': 'application/json' } });
const failing = (status: number) => () => new Response(JSON.stringify({ error: 'x', traceId }), { status, headers: { 'content-type': 'application/json' } });

test('after syncing online, a cold start without connection still opens the stored copy behind the device authentication', async () => {
  const d = device();
  const online = d.start(verified);
  await online.restore();
  assert.equal(online.getSnapshot().status, 'authenticated');
  const first = walletFor(online, d.cache, ok);
  assert.equal(first.access.mode, 'online');
  await first.wallet.unlock();
  assert.equal(first.wallet.getSnapshot().status, 'ready');
  first.wallet.lock();

  const offline = d.start(outage);
  await offline.restore();
  assert.deepEqual([offline.getSnapshot().status, offline.getSnapshot().failure], ['blocked', 'unavailable']);
  const second = walletFor(offline, d.cache, () => { throw new Error('the server must not be called'); });
  assert.equal(second.access.mode, 'offline');
  await second.wallet.unlock();
  const state = second.wallet.getSnapshot();
  assert.ok(state.status === 'ready' && state.source === 'stored' && state.syncedAt === now);
  assert.equal(state.status === 'ready' && state.policies[0].policyId, policy.policyId);
  assert.equal(second.calls.fetch, 0);
});

test('a real revocation signs the user out and removes the stored copy, so the wallet cannot be opened offline afterwards', async () => {
  const d = device();
  const online = d.start(verified);
  await online.restore();
  const first = walletFor(online, d.cache, ok);
  await first.wallet.unlock();
  first.wallet.lock();

  const revokedStart = d.start(revoked);
  await revokedStart.restore();
  assert.equal(revokedStart.getSnapshot().status, 'signedOut');
  assert.equal(walletAccessFor(revokedStart.getSnapshot()), null);
  await d.cache.unlock();
  assert.equal(await d.cache.readLatest(), null, 'the copy was cleared with the revoked session');
});

test('a revoked session whose cleanup failed keeps the wallet closed: an incomplete discard is not an unreachable server', async () => {
  const d = device();
  const online = d.start(verified);
  await online.restore();
  const first = walletFor(online, d.cache, ok);
  await first.wallet.unlock();
  first.wallet.lock();

  const failingCache = { clear: async () => { throw new Error('keychain refused the removal'); } };
  const api: SessionApi = { configuration: async () => config, register: async () => principal, inspect: revoked, access: async () => principal,
    logout: async () => {}, registerDevice: async () => {}, inspectDevice: async () => {}, revokeDevice: async () => {} };
  const stuck = new Authentication({ baseUrl, store: { read: async () => structuredClone(activeSession), write: async () => {} }, identity: { authorize: async () => { throw new Error('x'); },
    exchange: async () => { throw new Error('x'); }, refresh: async () => { throw new Error('x'); } }, api, browser: { assertAvailable: () => {}, open: async () => null },
  now: () => now, parseCallback, policyCache: failingCache });
  await stuck.restore();
  assert.deepEqual([stuck.getSnapshot().status, stuck.getSnapshot().failure], ['blocked', 'discard_incomplete']);
  assert.equal(walletAccessFor(stuck.getSnapshot()), null);
  await d.cache.unlock();
  assert.ok(await d.cache.readLatest(), 'the copy is still on the device, which is why the wallet must stay closed');
});

test('a block that is not an outage gives no wallet access, and neither does a pending logout', () => {
  assert.equal(walletAccessFor({ status: 'blocked', failure: 'forbidden' }), null);
  assert.equal(walletAccessFor({ status: 'blocked', failure: 'invalid_response' }), null);
  assert.equal(walletAccessFor({ status: 'blocked', failure: 'discard_incomplete' }), null);
  assert.equal(walletAccessFor({ status: 'logoutPending', failure: 'unavailable' }), null);
  assert.equal(walletAccessFor({ status: 'locked' }), null);
  assert.equal(walletAccessFor({ status: 'authenticated' }), null);
  assert.deepEqual(walletAccessFor({ status: 'authenticated', principal }), { mode: 'online', owner: principal });
});

test('a server integrity rejection after a good sync shows the error, not the previous copy', async () => {
  const d = device();
  const auth = d.start(verified);
  await auth.restore();
  const good = walletFor(auth, d.cache, ok);
  await good.wallet.unlock();
  assert.equal(good.wallet.getSnapshot().status, 'ready');
  const rejected = walletFor(auth, d.cache, failing(409));
  await rejected.wallet.unlock();
  assert.deepEqual(rejected.wallet.getSnapshot(), { status: 'failed', failure: 'integrity' });
});

test('outages fall back to the stored copy while contract mismatches do not', async () => {
  const d = device();
  const auth = d.start(verified);
  await auth.restore();
  const good = walletFor(auth, d.cache, ok);
  await good.wallet.unlock();
  for (const status of [500, 503, 429]) {
    const outageWallet = walletFor(auth, d.cache, failing(status));
    await outageWallet.wallet.unlock();
    const state = outageWallet.wallet.getSnapshot();
    assert.ok(state.status === 'ready' && state.source === 'stored', String(status));
  }
  for (const status of [400, 404, 405]) {
    const mismatch = walletFor(auth, d.cache, failing(status));
    await mismatch.wallet.unlock();
    assert.deepEqual(mismatch.wallet.getSnapshot(), { status: 'failed', failure: 'invalid_response' }, String(status));
  }
});

test('offline with no stored copy the wallet says so', async () => {
  const d = device();
  const offline = d.start(outage);
  await offline.restore();
  const { wallet } = walletFor(offline, d.cache, () => { throw new Error('the server must not be called'); });
  await wallet.unlock();
  assert.deepEqual(wallet.getSnapshot(), { status: 'failed', failure: 'no_copy' });
});
