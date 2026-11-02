import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';

import { Authentication } from '../apps/mobile/src/features/authentication/application/authentication';
import type { AuthBrowser, IdentityProvider, SessionApi, TokenStore } from '../apps/mobile/src/features/authentication/application/ports';
import { AuthFailure, emptyRecord } from '../apps/mobile/src/features/authentication/domain/session';
import type { AuthRecord, Configuration, Tokens } from '../apps/mobile/src/features/authentication/domain/session';
import { parseCallback } from '../apps/mobile/src/features/authentication/adapters/callback';
import { createSessionApi } from '../apps/mobile/src/features/authentication/adapters/solventa-session';
import { storedRecord } from '../apps/mobile/src/features/authentication/adapters/validation';
import { createWorkosIdentity } from '../apps/mobile/src/features/authentication/adapters/workos';
import { createAuthBrowser } from '../apps/mobile/src/features/authentication/adapters/browser-session';

const baseUrl = 'https://solventa-web-staging.ja-forerog1.workers.dev';
const config: Configuration = {
  clientId: 'client_01M47F209CBGBJGD73ZM39ADW6', redirectUri: 'solventa://auth/callback',
  authorizationEndpoint: 'https://api.workos.com/user_management/authorize',
  tokenEndpoint: 'https://api.workos.com/user_management/authenticate',
};
const state = 's'.repeat(43);
const verifier = 'v'.repeat(43);
const callback = `${config.redirectUri}?state=${state}&code=synthetic-code`;
const principal = { clientId: '00000000-0000-4000-8000-000000000001', subjectToken: '00000000-0000-4000-8000-000000000002' };
const traceId = '00000000-0000-4000-8000-000000000003';
const now = 1_800_000_000_000;
const tokens: Tokens = { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: now + 300_000 };

test('primary PKCE entry requests active reauthentication instead of silently reusing browser SSO', async () => {
  const authorization = await createWorkosIdentity().authorize(config);
  const url = new URL(authorization.url);
  assert.equal(url.searchParams.get('max_age'), '0');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  assert.equal(url.searchParams.get('state'), authorization.state);
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
});

test('native browser reuses the app task for every login and returns only successful callbacks', async () => {
  let opens = 0;
  let result: { type: string; url?: string } = { type: 'success', url: callback };
  const browser = createAuthBrowser({ assertAvailable: () => {}, openSession: async (url, redirect, options) => {
    opens++;
    assert.equal(url, 'https://synthetic.example/authorize');
    assert.equal(redirect, config.redirectUri);
    assert.deepEqual(options, { createTask: false, useProxyActivity: false, showInRecents: false });
    return result;
  } });
  for (let attempt = 0; attempt < 3; attempt++) assert.equal(await browser.open('https://synthetic.example/authorize', config.redirectUri), callback);
  for (const type of ['cancel', 'dismiss']) {
    result = { type }; assert.equal(await browser.open('https://synthetic.example/authorize', config.redirectUri), null);
  }
  result = { type: 'success' };
  await assert.rejects(browser.open('https://synthetic.example/authorize', config.redirectUri), error => error instanceof AuthFailure && error.kind === 'invalid_response');
  assert.equal(opens, 6);
});

test('unsupported native browser fails before launching another activity', async () => {
  const browser = createAuthBrowser({ assertAvailable: () => { throw new AuthFailure('native_required'); },
    openSession: async () => { assert.fail('browser must not open'); } });
  await assert.rejects(browser.open('https://synthetic.example/authorize', config.redirectUri), error => error instanceof AuthFailure && error.kind === 'native_required');
});

function fixture(initial: AuthRecord = emptyRecord()) {
  let saved = structuredClone(initial);
  let clock = now;
  const calls: string[] = [];
  const store: TokenStore = { read: async () => structuredClone(saved), write: async record => { saved = structuredClone(record); } };
  const identity: IdentityProvider = {
    authorize: async () => ({ url: 'https://synthetic.example/authorize', state, codeVerifier: verifier }),
    exchange: async (_config, code, proof) => { assert.equal(code, 'synthetic-code'); assert.equal(proof, verifier); calls.push('exchange'); return tokens; },
    refresh: async (_config, refresh) => { assert.equal(refresh, saved.session?.tokens.refreshToken); calls.push('refresh'); return { ...tokens, accessToken: 'rotated-access', refreshToken: 'rotated-refresh', expiresAt: clock + 300_000 }; },
  };
  const api: SessionApi = {
    configuration: async () => config,
    register: async () => { calls.push('register'); return principal; },
    inspect: async () => { calls.push('inspect'); return principal; },
    access: async () => { calls.push('access'); return principal; },
    logout: async () => { calls.push('logout'); },
    registerDevice: async () => { calls.push('registerDevice'); },
    inspectDevice: async () => { calls.push('inspectDevice'); },
    revokeDevice: async () => { calls.push('revokeDevice'); },
  };
  const browser: AuthBrowser = { assertAvailable: () => {}, open: async () => null };
  const auth = new Authentication({ baseUrl, store, identity, api, browser, now: () => clock, parseCallback });
  return { auth, api, identity, browser, store, calls, saved: () => saved, advance: (ms: number) => { clock += ms; } };
}

function transactionRecord(): AuthRecord {
  return { version: 1, session: null, transaction: { configuration: config, baseUrl, state, codeVerifier: verifier, expiresAt: now + 600_000 } };
}
function sessionRecord(phase: 'active' | 'bootstrap' | 'logout' = 'active'): AuthRecord {
  return { version: 1, transaction: null, session: { configuration: config, baseUrl, tokens, phase } };
}

test('authenticated feature requests use the current credential without exposing it in observable state', async () => {
  const f = fixture(sessionRecord()); await f.auth.restore();
  assert.equal(await f.auth.withSession(async token => { assert.equal(token, tokens.accessToken); return 'safe-result'; }), 'safe-result');
  assert.equal(JSON.stringify(f.auth.getSnapshot()).includes(tokens.accessToken), false);
  assert.equal(f.auth.getApiBaseUrl(), baseUrl);
  f.auth.lock();
  let reads = 0; f.store.read = async () => { reads++; return sessionRecord(); };
  await assert.rejects(f.auth.withSession(async () => assert.fail('locked feature must not run')), AuthFailure);
  assert.equal(reads, 0);
});

test('backgrounding while a feature refreshes cannot release a credential to its callback', async () => {
  const f = fixture(sessionRecord()); await f.auth.restore(); f.advance(300_000);
  let start!: () => void; const started = new Promise<void>(resolve => { start = resolve; });
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  const original = f.identity.refresh;
  f.identity.refresh = async (...args) => { start(); await waiting; return original(...args); };
  const request = f.auth.withSession(async () => assert.fail('background request must not run'));
  await started; f.auth.lock(); release();
  await assert.rejects(request, AuthFailure);
  assert.notEqual(f.auth.getSnapshot().status, 'authenticated');
});

test('logout discards a late feature result and serializes remote session revocation', async () => {
  const f = fixture(sessionRecord()); await f.auth.restore();
  let start!: () => void; const started = new Promise<void>(resolve => { start = resolve; });
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  const request = f.auth.withSession(async () => { start(); await waiting; return 'late-approval'; });
  await started; const logout = f.auth.signOut(); release();
  await assert.rejects(request, AuthFailure); await logout;
  assert.equal(f.auth.getSnapshot().status, 'signedOut');
  assert.equal(f.calls.filter(call => call === 'logout').length, 1);
});

test('feature authorization denial blocks the active session while ordinary business errors preserve it', async () => {
  const f = fixture(sessionRecord()); await f.auth.restore();
  await assert.rejects(f.auth.withSession(async () => { throw new Error('business_conflict'); }), /business_conflict/);
  assert.equal(f.auth.getSnapshot().status, 'authenticated');
  await assert.rejects(f.auth.withSession(async () => { throw new AuthFailure('unauthorized', traceId); }), AuthFailure);
  assert.equal(f.auth.getSnapshot().status, 'signedOut');
  assert.deepEqual(f.saved(), emptyRecord());
});

test('PKCE callback registers, inspects and checks access before granting entry; duplicate delivery cannot exchange twice', async () => {
  const f = fixture(transactionRecord());
  await Promise.all([f.auth.complete(callback), f.auth.complete(callback)]);
  assert.deepEqual(f.calls, ['exchange', 'register', 'inspect', 'access']);
  assert.equal(f.auth.getSnapshot().status, 'authenticated');
  assert.deepEqual(f.auth.getSnapshot().principal, principal);
  assert.equal(f.saved().transaction, null);
  assert.equal(f.saved().session?.phase, 'active');
  assert.equal(JSON.stringify(f.auth.getSnapshot()).includes('synthetic-access'), false);
});

test('wrong state, expired and unsolicited callbacks cannot exchange or grant access', async () => {
  for (const record of [transactionRecord(), emptyRecord()]) {
    const f = fixture(record);
    await f.auth.complete(callback.replace(state, 'x'.repeat(43)));
    assert.equal(f.auth.getSnapshot().failure, 'invalid_callback');
    assert.deepEqual(f.calls, []);
  }
  const f = fixture(transactionRecord());
  f.advance(600_000);
  await f.auth.complete(callback);
  assert.equal(f.auth.getSnapshot().status, 'signedOut');
  assert.deepEqual(f.calls, []);
});

test('rejects callback route substitutions, duplicate parameters, fragments and mixed error/code', () => {
  for (const url of [callback.replace('auth/callback', 'other/callback'), callback.replace('solventa:', 'https:'),
    `${callback}&state=${state}`, `${callback}&code=other`, `${callback}&error=access_denied`, `${callback}#fragment`,
    `${config.redirectUri}?code=synthetic-code`, callback.replace('/callback?', '/callback/?')]) {
    assert.throws(() => parseCallback(url), error => error instanceof AuthFailure && error.kind === 'invalid_callback');
  }
});

test('provider cancellation silently returns to signed-out entry and consumes the OAuth transaction', async () => {
  const f = fixture(transactionRecord());
  await f.auth.complete(`${config.redirectUri}?state=${state}&error=access_denied`);
  assert.equal(f.auth.getSnapshot().status, 'signedOut');
  assert.equal(f.auth.getSnapshot().failure, undefined);
  assert.equal(f.auth.getSnapshot().traceId, undefined);
  assert.deepEqual(f.saved(), emptyRecord());
  assert.deepEqual(f.calls, []);
});

test('browser cancellation silently returns to signed-out entry, grants no access and deletes the verifier', async () => {
  const f = fixture();
  await f.auth.restore();
  await f.auth.signIn();
  assert.equal(f.auth.getSnapshot().status, 'signedOut');
  assert.equal(f.auth.getSnapshot().failure, undefined);
  assert.equal(f.auth.getSnapshot().traceId, undefined);
  assert.deepEqual(f.saved(), emptyRecord());
  assert.deepEqual(f.calls, []);
});

test('unsupported runtimes report native_required before storage, network or PKCE, including repeated attempts', async () => {
  const f = fixture();
  f.browser.assertAvailable = () => { throw new AuthFailure('native_required'); };
  const unexpected = async (): Promise<never> => { assert.fail('unsupported runtime must stop before native or network work'); };
  f.store.read = unexpected;
  f.store.write = unexpected;
  f.api.configuration = unexpected;
  f.identity.authorize = unexpected;
  f.browser.open = unexpected;
  for (let attempt = 0; attempt < 2; attempt++) {
    await f.auth.signIn();
    assert.equal(f.auth.getSnapshot().status, 'signedOut');
    assert.equal(f.auth.getSnapshot().failure, 'native_required');
    assert.deepEqual(f.saved(), emptyRecord());
  }
});

test('a bootstrap outage retains a pending session, blocks access and permits bounded explicit retry', async () => {
  const f = fixture(transactionRecord());
  const register = f.api.register;
  f.api.register = async () => { throw new AuthFailure('unavailable', traceId); };
  await f.auth.complete(callback);
  assert.equal(f.auth.getSnapshot().status, 'blocked');
  assert.equal(f.auth.getSnapshot().traceId, traceId);
  assert.equal(f.saved().session?.phase, 'bootstrap');
  assert.deepEqual(f.calls, ['exchange']);
  f.api.register = register;
  await f.auth.retry();
  assert.equal(f.auth.getSnapshot().status, 'authenticated');
});

test('revoked local sessions are discarded without rebootstrap or unnecessary provider refresh', async () => {
  const f = fixture(sessionRecord());
  f.api.inspect = async () => { throw new AuthFailure('unauthorized'); };
  await f.auth.restore();
  assert.equal(f.auth.getSnapshot().status, 'signedOut');
  assert.deepEqual(f.saved(), emptyRecord());
  assert.deepEqual(f.calls, []);
});

test('restoration validates server session and access even when the access token has not expired', async () => {
  const f = fixture(sessionRecord());
  await f.auth.restore();
  assert.deepEqual(f.calls, ['inspect', 'access']);
  f.auth.lock();
  assert.equal(f.auth.getSnapshot().status, 'loading');
  f.api.access = async () => { throw new AuthFailure('forbidden'); };
  await f.auth.restore();
  assert.equal(f.auth.getSnapshot().status, 'blocked');
  assert.equal(f.auth.getSnapshot().principal, undefined);
});

test('concurrent resumes rotate once and persist both replacement tokens before using them', async () => {
  const f = fixture(sessionRecord());
  f.advance(250_000);
  f.api.inspect = async token => { assert.equal(token, 'rotated-access'); assert.equal(f.saved().session?.tokens.refreshToken, 'rotated-refresh'); return principal; };
  await Promise.all([f.auth.restore(), f.auth.restore(), f.auth.retry()]);
  assert.equal(f.calls.filter(call => call === 'refresh').length, 1);
  assert.equal(f.auth.getSnapshot().status, 'authenticated');
});

test('an access token expiring during a read refreshes and retries that read once', async () => {
  const f = fixture(sessionRecord());
  let attempts = 0;
  f.api.inspect = async () => {
    attempts++;
    if (attempts === 1) { f.advance(300_000); throw new AuthFailure('unauthorized'); }
    return principal;
  };
  await f.auth.restore();
  assert.equal(attempts, 2);
  assert.deepEqual(f.calls, ['refresh', 'access']);
  assert.equal(f.auth.getSnapshot().status, 'authenticated');
});

test('denied refresh discards credentials and requires primary login', async () => {
  const f = fixture(sessionRecord());
  f.advance(300_000);
  f.identity.refresh = async () => { throw new AuthFailure('unauthorized'); };
  await f.auth.restore();
  assert.equal(f.auth.getSnapshot().status, 'signedOut');
  assert.deepEqual(f.saved(), emptyRecord());
  assert.deepEqual(f.calls, []);
});

test('transient refresh errors preserve credentials but cannot grant access', async () => {
  const f = fixture(sessionRecord());
  f.advance(300_000);
  f.identity.refresh = async () => { throw new AuthFailure('unavailable'); };
  await f.auth.restore();
  assert.equal(f.auth.getSnapshot().status, 'blocked');
  assert.ok(f.saved().session);
  assert.deepEqual(f.calls, []);
});

test('logout blocks immediately, persists its intent offline and only retries DELETE after restart', async () => {
  const f = fixture(sessionRecord());
  f.api.logout = async () => { throw new AuthFailure('unavailable'); };
  const operation = f.auth.signOut();
  assert.equal(f.auth.getSnapshot().status, 'logoutPending');
  await operation;
  assert.equal(f.saved().session?.phase, 'logout');
  assert.equal(f.auth.getSnapshot().status, 'logoutPending');
  const restarted = fixture(f.saved());
  await restarted.auth.restore();
  assert.deepEqual(restarted.calls, ['logout']);
  assert.deepEqual(restarted.saved(), emptyRecord());
  assert.equal(restarted.auth.getSnapshot().status, 'signedOut');
});

test('logout can revoke a pending bootstrap without registering it first', async () => {
  const f = fixture(sessionRecord('bootstrap'));
  await f.auth.signOut();
  assert.deepEqual(f.calls, ['logout']);
  assert.deepEqual(f.saved(), emptyRecord());
});

test('invalid pending logout credentials are discarded without claiming successful remote revocation', async () => {
  const f = fixture(sessionRecord('logout'));
  f.advance(300_000);
  f.identity.refresh = async () => { throw new AuthFailure('unauthorized'); };
  await f.auth.restore();
  assert.equal(f.auth.getSnapshot().failure, 'logout_unconfirmed');
  assert.deepEqual(f.saved(), emptyRecord());
});

test('environment changes discard credentials before calling any provider or backend', async () => {
  const record = sessionRecord();
  assert.ok(record.session);
  record.session.baseUrl = 'https://solventa-web-dev.ja-forerog1.workers.dev';
  const f = fixture(record);
  await f.auth.restore();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.saved(), emptyRecord());
});

test('a different principal in the permission probe never grants access', async () => {
  const f = fixture(sessionRecord());
  f.api.access = async () => ({ ...principal, clientId: traceId });
  await f.auth.restore();
  assert.equal(f.auth.getSnapshot().failure, 'invalid_response');
  assert.equal(f.auth.getSnapshot().status, 'blocked');
});

test('invalid secure records reject mixed sessions and transactions and malformed token pairs', () => {
  assert.throws(() => storedRecord({ ...sessionRecord(), transaction: transactionRecord().transaction }));
  const record = sessionRecord();
  assert.ok(record.session);
  assert.throws(() => storedRecord({ ...record, session: { ...record.session, tokens: { ...tokens, refreshToken: '' } } }));
  assert.deepEqual(storedRecord(record), record);
});

test('HTTP lifecycle uses only Bearer, no cookies or bodies, and validates real contract responses', async () => {
  const requests: { path: string; options?: RequestInit }[] = [];
  const fakeFetch: typeof fetch = async (input, options) => {
    const path = String(input).replace(`${baseUrl}/api/v1`, '');
    requests.push({ path, options });
    const body = path === '/mobile/config' ? { ...config, traceId } : options?.method === 'DELETE' ? { status: 'signed_out', traceId }
      : path === '/access/mobile' ? { actor: { kind: 'user', channel: 'mobile', principal, operations: ['quotes:create'] }, traceId }
        : { channel: 'mobile', principal, traceId };
    return Response.json(body);
  };
  const api = createSessionApi(baseUrl, fakeFetch);
  assert.deepEqual(await api.configuration(), config);
  await api.register(tokens.accessToken);
  await api.inspect(tokens.accessToken);
  await api.access(tokens.accessToken);
  await api.logout(tokens.accessToken);
  assert.deepEqual(requests.map(item => [item.path, item.options?.method]), [
    ['/mobile/config', 'GET'], ['/mobile/session', 'POST'], ['/mobile/session', 'GET'], ['/access/mobile', 'GET'], ['/mobile/session', 'DELETE'],
  ]);
  for (const { options } of requests) {
    assert.equal(options?.credentials, 'omit');
    assert.equal(options?.body, undefined);
    assert.equal(new Headers(options?.headers).has('Cookie'), false);
  }
  assert.equal(new Headers(requests[0].options?.headers).has('Authorization'), false);
  assert.equal(new Headers(requests[1].options?.headers).get('Authorization'), `Bearer ${tokens.accessToken}`);
});

test('HTTP 503 has a two-attempt bound; 401 never retries and exposes only sanitized correlation', async () => {
  let attempts = 0;
  const unavailable = createSessionApi(baseUrl, async () => { attempts++; return Response.json({ error: 'access_unavailable', traceId }, { status: 503 }); });
  await assert.rejects(unavailable.register(tokens.accessToken), error => error instanceof AuthFailure && error.kind === 'unavailable' && error.traceId === traceId);
  assert.equal(attempts, 2);
  attempts = 0;
  const unauthorized = createSessionApi(baseUrl, async () => { attempts++; return Response.json({ error: 'unauthorized', traceId: 'sensitive-untrusted-text' }, { status: 401 }); });
  await assert.rejects(unauthorized.inspect(tokens.accessToken), error => error instanceof AuthFailure && error.kind === 'unauthorized' && error.traceId === undefined);
  assert.equal(attempts, 1);
});

test('device requests normalize UUID case and validate the canonical response without cookies or bodies', async () => {
  const upper = 'ABCDEF12-3456-4789-8ABC-DEF012345678';
  for (const method of ['POST', 'GET', 'DELETE'] as const) {
    const api = createSessionApi(baseUrl, async (url, options) => {
      assert.equal(String(url), `${baseUrl}/api/v1/mobile/devices/${upper.toLowerCase()}`);
      assert.equal(options?.method, method);
      assert.equal(options?.credentials, 'omit');
      assert.equal(options?.body, undefined);
      assert.equal(new Headers(options?.headers).has('Cookie'), false);
      return Response.json({ device: { id: principal.clientId, installationId: upper.toLowerCase(), status: method === 'DELETE' ? 'revoked' : 'active' }, traceId });
    });
    if (method === 'POST') await api.registerDevice(tokens.accessToken, upper);
    else if (method === 'GET') await api.inspectDevice(tokens.accessToken, upper);
    else await api.revokeDevice(tokens.accessToken, upper);
  }
});

test('configuration and server responses cannot redirect token exchange to another environment or endpoint', async () => {
  for (const changed of [{ clientId: 'client_other' }, { redirectUri: 'other://callback' }, { tokenEndpoint: 'https://attacker.example' }]) {
    const api = createSessionApi(baseUrl, async () => Response.json({ ...config, ...changed, traceId }));
    await assert.rejects(api.configuration(), error => error instanceof AuthFailure && error.kind === 'invalid_response');
  }
  assert.throws(() => createSessionApi('https://attacker.example'));
  const api = createSessionApi(baseUrl, async () => Response.json({ channel: 'web', principal, traceId }));
  await assert.rejects(api.inspect(tokens.accessToken));
});

test('canonical and legacy API origins remain pinned to the client for their environment', async () => {
  const origins = [
    ['https://dev.solventa.site', 'client_01M47F52THNNZZZ4WSGACX8KA4'],
    ['https://solventa-web-dev.ja-forerog1.workers.dev', 'client_01M47F52THNNZZZ4WSGACX8KA4'],
    ['https://staging.solventa.site', 'client_01M47F209CBGBJGD73ZM39ADW6'],
    ['https://solventa-web-staging.ja-forerog1.workers.dev', 'client_01M47F209CBGBJGD73ZM39ADW6'],
    ['https://solventa.site', 'client_01M47F21P884580Q2GGF81NRV5'],
    ['https://solventa-web-prod.ja-forerog1.workers.dev', 'client_01M47F21P884580Q2GGF81NRV5'],
  ] as const;
  for (const [origin, clientId] of origins) {
    const api = createSessionApi(origin, async () => Response.json({ ...config, clientId, traceId }));
    assert.equal((await api.configuration()).clientId, clientId);
  }
});

test('the installed WorkOS SDK generates unique state and S256 challenges without a server key', async context => {
  context.mock.method(globalThis, 'fetch', async () => { throw new Error('PKCE must not call the network'); });
  const identity = createWorkosIdentity();
  const first = await identity.authorize(config);
  const second = await identity.authorize(config);
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.codeVerifier, second.codeVerifier);
  const url = new URL(first.url);
  assert.equal(`${url.origin}${url.pathname}`, config.authorizationEndpoint);
  assert.equal(url.searchParams.get('client_id'), config.clientId);
  assert.equal(url.searchParams.get('state'), first.state);
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(first.codeVerifier).digest('base64url'));
  assert.equal(url.searchParams.has('client_secret'), false);
});

test('SDK code exchange and refresh use public credentials, and denied exchanges are sanitized without retries', async context => {
  const requests: RequestInit[] = [];
  context.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, options?: RequestInit) => {
    requests.push(options ?? {});
    return Response.json({ error: 'invalid_grant', error_description: 'sensitive-provider-description' }, { status: 400 });
  });
  const identity = createWorkosIdentity();
  await assert.rejects(identity.exchange(config, 'synthetic-code', verifier), error => error instanceof AuthFailure && error.kind === 'unauthorized' && !error.message.includes('sensitive'));
  await assert.rejects(identity.refresh(config, 'synthetic-refresh'), error => error instanceof AuthFailure && error.kind === 'unauthorized');
  assert.equal(requests.length, 2);
  const codeBody = JSON.parse(String(requests[0].body));
  assert.equal(codeBody.client_id, config.clientId);
  assert.equal(codeBody.code_verifier, verifier);
  assert.equal(codeBody.client_secret, undefined);
  const refreshBody = JSON.parse(String(requests[1].body));
  assert.equal(refreshBody.grant_type, 'refresh_token');
  assert.equal(refreshBody.client_id, config.clientId);
  assert.equal(refreshBody.client_secret, undefined);
  for (const request of requests) assert.equal(new Headers(request.headers).has('Authorization'), false);
});

test('failed persistence of logout intent cannot allow a subsequent retry to restore access', async () => {
  const f = fixture(sessionRecord());
  await f.auth.restore();
  const write = f.store.write;
  f.store.write = async () => { throw new Error('Storage unavailable'); };
  await f.auth.signOut();
  assert.equal(f.auth.getSnapshot().status, 'logoutPending');
  f.store.write = write;
  f.calls.length = 0;
  await f.auth.retry();
  assert.deepEqual(f.calls, ['logout']);
  assert.equal(f.auth.getSnapshot().status, 'signedOut');
});

test('a stale callback on cold launch cannot skip server validation or pending revocation', async () => {
  for (const phase of ['active', 'logout'] as const) {
    const f = fixture(sessionRecord(phase));
    await f.auth.complete(callback);
    assert.deepEqual(f.calls, phase === 'active' ? ['inspect', 'access'] : ['logout']);
    assert.equal(f.auth.getSnapshot().status, phase === 'active' ? 'authenticated' : 'signedOut');
  }
});

test('SDK responses persist only a valid environment-bound access/refresh pair', async context => {
  const exp = Math.floor(Date.now() / 1000) + 300;
  const claims = { client_id: config.clientId, iss: `https://api.workos.com/user_management/${config.clientId}`, sub: 'user_synthetic', exp };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const accessToken = `${encode({ alg: 'RS256' })}.${encode(claims)}.synthetic-signature`;
  let body: Record<string, unknown> = {
    access_token: accessToken, refresh_token: 'synthetic-refresh',
    authentication_method: 'Password',
    user: { id: 'user_synthetic', email: 'synthetic@example.test', email_verified: true,
      first_name: null, last_name: null, profile_picture_url: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', metadata: {} },
  };
  context.mock.method(globalThis, 'fetch', async () => Response.json(body));
  const identity = createWorkosIdentity();
  assert.deepEqual(await identity.exchange(config, 'synthetic-code', verifier), {
    accessToken, refreshToken: 'synthetic-refresh', expiresAt: exp * 1000, email: 'synthetic@example.test',
  });
  const originalUser = body.user;
  assert.ok(originalUser && typeof originalUser === 'object');
  for (const change of [{ email_verified: false }, { id: 'user_other' }, { email: 'invalid\n@example.test' }, { email: 'x'.repeat(255) + '@example.test' }]) {
    body = { ...body, user: { ...originalUser, ...change } };
    assert.equal((await identity.refresh(config, 'synthetic-refresh')).email, undefined);
  }
  body = { ...body, user: originalUser };
  body = { ...body, access_token: `${encode({ alg: 'RS256' })}.${encode({ ...claims, client_id: 'client_foreign' })}.synthetic-signature` };
  await assert.rejects(identity.refresh(config, 'synthetic-refresh'), error => error instanceof AuthFailure && error.kind === 'invalid_response');
});

test('a mistakenly inherited server credential cannot be sent by the public adapter', async context => {
  const previous = process.env.WORKOS_API_KEY;
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Unexpected request'); });
  process.env.WORKOS_API_KEY = 'sk_synthetic_not_a_secret';
  try {
    await assert.rejects(createWorkosIdentity().authorize(config), error => error instanceof AuthFailure && error.kind === 'invalid_response');
    assert.equal(calls, 0);
  } finally {
    if (previous === undefined) delete process.env.WORKOS_API_KEY;
    else process.env.WORKOS_API_KEY = previous;
  }
});

test('a failed credential deletion after denial remains blocked, not a successful sign-out', async () => {
  const f = fixture(sessionRecord());
  const write = f.store.write;
  f.store.write = async () => { throw new Error('Storage unavailable'); };
  f.api.inspect = async () => { throw new AuthFailure('unauthorized'); };
  await f.auth.restore();
  assert.equal(f.auth.getSnapshot().status, 'blocked');
  assert.equal(f.auth.getSnapshot().principal, undefined);
  f.store.write = write;
  await f.auth.retry();
  assert.equal(f.auth.getSnapshot().status, 'signedOut');
  assert.deepEqual(f.saved(), emptyRecord());
});

test('email is display-only and hidden until backend access succeeds, while locked and after logout', async () => {
  const f = fixture(transactionRecord());
  f.identity.exchange = async () => ({ ...tokens, email: 'synthetic@example.test' });
  const access = f.api.access;
  f.api.access = async () => { throw new AuthFailure('unavailable'); };
  await f.auth.complete(callback);
  assert.equal(f.auth.getSnapshot().status, 'blocked');
  assert.equal(f.auth.getSnapshot().email, undefined);
  assert.equal(f.saved().session?.email, 'synthetic@example.test');
  f.api.access = access; await f.auth.retry();
  assert.equal(f.auth.getSnapshot().email, 'synthetic@example.test');
  assert.deepEqual(f.auth.getSnapshot().principal, principal);
  f.auth.lock(); assert.equal(f.auth.getSnapshot().email, undefined);
  f.auth.resume(); await f.auth.restore();
  assert.equal(f.auth.getSnapshot().email, 'synthetic@example.test');
  f.api.logout = async () => { throw new AuthFailure('unavailable'); };
  await f.auth.signOut();
  assert.equal(f.auth.getSnapshot().email, undefined);
  assert.equal(f.saved().session?.email, undefined);
  f.api.logout = async () => {}; await f.auth.retry();
  assert.deepEqual(f.saved(), emptyRecord());
});

test('refresh preserves the secure email when absent and updates it when supplied by the provider', async () => {
  const record = sessionRecord(); assert.ok(record.session); record.session.email = 'old@example.test';
  const f = fixture(record); f.advance(250_000); await f.auth.restore();
  assert.equal(f.auth.getSnapshot().email, 'old@example.test');
  f.advance(300_000);
  f.identity.refresh = async () => ({ ...tokens, expiresAt: now + 900_000, email: 'updated@example.test' });
  await f.auth.restore();
  assert.equal(f.auth.getSnapshot().email, 'updated@example.test');
  assert.equal(f.saved().session?.email, 'updated@example.test');
});

test('legacy secure records need no email and malformed display metadata never breaks authentication', () => {
  const record = sessionRecord(); assert.ok(record.session);
  assert.equal(storedRecord(record).session?.email, undefined);
  for (const email of [null, ['synthetic@example.test'], 'invalid', 'synthetic\n@example.test', 'x'.repeat(255) + '@example.test']) {
    assert.equal(storedRecord({ ...record, session: { ...record.session, email } }).session?.email, undefined);
  }
  assert.equal(storedRecord({ ...record, session: { ...record.session, email: 'synthetic@example.test' } }).session?.email, 'synthetic@example.test');
});
