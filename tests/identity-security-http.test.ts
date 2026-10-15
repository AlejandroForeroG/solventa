import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityDecisions } from '../backend/identity-consent-ecosystem/src/application/security-decisions';
import type { SecurityDecision } from '../backend/identity-consent-ecosystem/src/domain/security-decision';
import { authorizeApiAccess } from '../backend/identity-consent-ecosystem/src/adapters/inbound/api-access-http';
import type { ApiAccessDependencies } from '../backend/identity-consent-ecosystem/src/adapters/inbound/api-access-http';
import { createHttp } from '../backend/identity-consent-ecosystem/src/adapters/inbound/http';
import { ApiAccess } from '../backend/identity-consent-ecosystem/src/application/api-access';
import { MobileSessions } from '../backend/identity-consent-ecosystem/src/application/mobile-sessions';
import { RegisteredDevices } from '../backend/identity-consent-ecosystem/src/application/registered-devices';
import { Consents } from '../backend/identity-consent-ecosystem/src/application/consents';
import { HmacIntegrity } from '../backend/identity-consent-ecosystem/src/adapters/outbound/hmac-integrity';
import { MemoryConsents, SEAL_KEY, TRACE, clock } from './support/consent-fakes';
import { createHttp as createQuoteHttp } from '../backend/acquisition-risk/src/adapters/inbound/http';
import { CreateQuote } from '../backend/acquisition-risk/src/application/create-quote';
import { IdentityApiAccess } from '../backend/acquisition-risk/src/adapters/outbound/identity-api-access';
import { MemoryStore, protector } from './support/quote-fakes';

const origin = 'https://solventa-web-dev.ja-forerog1.workers.dev';
const env = { APP_ENV: 'dev', AUTH_ORIGIN: origin, AUTH_REDIRECT_URI: origin + '/auth/callback', WORKOS_CLIENT_ID: 'client_synthetic', WORKOS_API_KEY: 'sk_synthetic', AUTH_COOKIE_PASSWORD: 'a'.repeat(64), IDENTITY_DB: { connectionString: 'postgresql://synthetic.invalid/unused' } } as IdentityEnv;
function fixture(webConfigured = true) {
  const events: SecurityDecision[] = [];
  let fail = false;
  const security = new SecurityDecisions({ append: async event => { if (fail) throw Error('synthetic-private-storage'); events.push(event); } }, () => crypto.randomUUID());
  const sessions = { find: async () => null, open: async () => assert.fail('unexpected registration'), revoke: async () => assert.fail('unexpected logout') };
  const provider = { authenticate: async () => null, begin: async () => assert.fail('unexpected login'), exchange: async () => assert.fail('unexpected exchange'), revoke: async () => {}, logoutUrl: () => '' };
  const deps: ApiAccessDependencies = { application: new ApiAccess({ find: async () => null }, sessions), security, partner: { authenticate: async () => null },
    web: webConfigured ? { authenticate: async () => null, allowedOrigins: [origin] } : null };
  const app = createHttp({
    security, authorizeApiAccess: input => authorizeApiAccess(deps, input),
    authentication: { provider: () => provider, sessions: () => sessions },
    consents: new Consents({ store: new MemoryConsents(), platform: clock(), integrity: new HmacIntegrity(SEAL_KEY), security }),
    mobile: { configuration: { clientId: 'client_synthetic', redirectUri: 'solventa://auth/callback' }, provider, sessions: new MobileSessions(sessions) },
    devices: new RegisteredDevices({ execute: async () => assert.fail('unexpected device store access') }, security),
  });
  return { app, deps, events, fail: () => { fail = true; } };
}

test('cross-alias consent and quote writes preserve their correlation and require durable denial recording', async () => {
  const canonical = 'https://dev.solventa.site';
  for (const failing of [false, true]) {
    for (const [target, source] of [[canonical, origin], [origin, canonical]]) {
      const state = fixture();
      state.deps.web = { allowedOrigins: [canonical, origin], defaultOrigin: origin,
        authenticate: async () => assert.fail('cross-alias write reached provider') };
      if (failing) state.fail();
      const store = new MemoryStore();
      const access = new IdentityApiAccess({ authorizeApiAccessV1: input => authorizeApiAccess(state.deps, input) });
      const quotes = createQuoteHttp({ quotes: new CreateQuote({ access, store, clock: { now: () => new Date() }, protector }) });
      for (const [app, path] of [[state.app, '/api/v1/consents'], [quotes, '/api/v1/me/quotes']] as const) {
        const response = await app.request(target + path, { method: 'POST', headers: {
          Origin: source, Cookie: '__Host-solventa-session=synthetic-private-cookie', 'X-Trace-Id': TRACE.toUpperCase(),
          'X-Request-Origin': source, 'X-Forwarded-Host': new URL(source).host, 'Content-Type': 'application/json',
        }, body: '{}' }, env);
        assert.equal(response.status, failing ? 503 : 403);
        assert.deepEqual(await response.json(), { error: failing ? 'access_unavailable' : 'forbidden', traceId: TRACE });
        assert.equal(response.headers.get('x-trace-id'), TRACE);
      }
      assert.equal(store.saved.length, 0);
      assert.equal(state.events.length, failing ? 0 : 2);
      assert.ok(state.events.every(event => event.correlationId === TRACE && event.cause === 'forbidden'));
      assert.ok(!JSON.stringify(state.events).includes('synthetic-private-cookie'));
    }
  }
});

test('an absent web cookie is recorded without a provider while supplied cookies require configuration', async () => {
  const state = fixture(false);
  const headers = { 'X-Trace-Id': TRACE };
  const missing = await state.app.request(origin + '/api/v1/access/web', { headers }, env);
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { error: 'unauthorized', traceId: TRACE });
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].correlationId, TRACE);
  assert.equal(state.events[0].cause, 'unauthorized');
  const supplied = await state.app.request(origin + '/api/v1/access/web', { headers: { ...headers, Cookie: '__Host-solventa-session=synthetic-private-cookie' } }, env);
  assert.equal(supplied.status, 503);
  assert.deepEqual(await supplied.json(), { error: 'access_unavailable', traceId: TRACE });
  assert.equal(state.events.length, 1, 'configuration unavailability is not a security-denial event');
  state.fail();
  const unavailable = await state.app.request(origin + '/api/v1/access/web', { headers }, env);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: 'access_unavailable', traceId: TRACE });
  assert.equal(state.events.length, 1, 'a failed append cannot claim another committed denial');
});

test('protected HTTP denials persist exactly once with the response correlation and no request data', async () => {
  const state = fixture();
  for (const path of ['/api/v1/access/partner', '/api/v1/access/web', '/api/v1/access/mobile', '/api/v1/consents', '/api/v1/mobile/session', `/api/v1/mobile/devices/${crypto.randomUUID()}`]) {
    const response = await state.app.request(origin + path, { headers: { 'X-Trace-Id': TRACE, 'X-Private-Synthetic': 'synthetic@example.invalid' } }, env);
    assert.equal(response.status, 401, path);
    assert.equal(response.headers.get('x-trace-id'), TRACE);
    assert.deepEqual(Object.keys(await response.json()).sort(), ['error', 'traceId']);
  }
  assert.equal(state.events.length, 6);
  assert.ok(state.events.every(event => event.correlationId === TRACE));
  assert.ok(!JSON.stringify(state.events).includes('synthetic@example.invalid'));
  const denied = await state.app.request(origin + '/api/v1/consents', { method: 'POST', headers: { origin: 'https://foreign.invalid', cookie: '__Host-solventa-session=synthetic-private-cookie', 'X-Trace-Id': TRACE } }, env);
  assert.equal(denied.status, 403);
  assert.equal(state.events.at(-1)?.cause, 'forbidden');
});

test('normal anonymous session inspection is distinct from invalid supplied credentials and denied logout', async () => {
  const state = fixture();
  assert.equal((await state.app.request(origin + '/auth/session', {}, env)).status, 401);
  assert.equal(state.events.length, 0);
  const invalid = await state.app.request(origin + '/auth/session', { headers: { cookie: '__Host-solventa-session=synthetic-private-cookie', 'X-Trace-Id': TRACE } }, env);
  assert.equal(invalid.status, 401);
  assert.equal(invalid.headers.get('x-trace-id'), TRACE);
  const csrf = await state.app.request(origin + '/auth/logout', { method: 'POST', headers: { origin: 'https://foreign.invalid', 'X-Trace-Id': TRACE } }, env);
  assert.equal(csrf.status, 403);
  assert.deepEqual(state.events.map(event => event.cause), ['unauthorized', 'forbidden']);
  assert.ok(state.events.every(event => event.operation === 'web:session'));
});

test('failed security persistence returns 503 and never claims a recorded denial or exposes its error', async () => {
  const state = fixture();
  state.fail();
  for (const path of ['/api/v1/access/partner', '/api/v1/consents', '/api/v1/mobile/session', `/api/v1/mobile/devices/${crypto.randomUUID()}`]) {
    const response = await state.app.request(origin + path, { headers: { 'X-Trace-Id': TRACE } }, env);
    assert.equal(response.status, 503, path);
    assert.deepEqual(await response.json(), { error: 'access_unavailable', traceId: TRACE });
  }
  assert.equal(state.events.length, 0);
  const response = await state.app.request(origin + '/auth/session', { headers: { cookie: '__Host-solventa-session=synthetic' } }, env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'authentication_unavailable' });
});

test('uppercase and invalid request traces produce one canonical response and security correlation', async () => {
  const state = fixture();
  for (const trace of [TRACE.toUpperCase(), 'synthetic-private-trace']) {
    const response = await state.app.request(origin + '/api/v1/access/partner', { headers: { 'X-Trace-Id': trace } }, env);
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.traceId, response.headers.get('x-trace-id'));
    assert.equal(body.traceId, state.events.at(-1)?.correlationId);
    assert.equal(body.traceId, body.traceId.toLowerCase());
    assert.notEqual(body.traceId, 'synthetic-private-trace');
  }
});

test('quote HTTP missing and oversized credentials persist Identity denials before replying, with no quote write', async () => {
  for (const failing of [false, true]) {
    const events: SecurityDecision[] = [];
    const requests: unknown[] = [];
    const security = new SecurityDecisions({ append: async event => {
      if (failing) throw Error('synthetic-private-security-store');
      events.push(event);
    } }, () => crypto.randomUUID());
    const principal = { clientId: crypto.randomUUID(), subjectToken: crypto.randomUUID() };
    const identity = { providerSubject: 'synthetic-user', sessionReference: 'synthetic-session', emailVerified: true };
    const deps = {
      security, application: new ApiAccess({ find: async () => null }, {
        find: async () => principal, open: async () => assert.fail('unexpected registration'), revoke: async () => assert.fail('unexpected logout'),
      }),
      partner: { authenticate: async () => null },
      web: { allowedOrigins: [origin], authenticate: async (cookie: string) => cookie === 'sealed-cookie' ? { identity } : null },
    };
    const access = new IdentityApiAccess({ authorizeApiAccessV1: async input => { requests.push(input); return authorizeApiAccess(deps, input); } });
    const store = new MemoryStore();
    const quotes = new CreateQuote({ access, store, clock: { now: () => new Date() }, protector });
    const app = createQuoteHttp({ quotes });
    const cases: { path: string; headers: Record<string, string>; status: 401 | 403 }[] = [
      { path: '/api/v1/quotes', headers: {}, status: 401 },
      { path: '/api/v1/quotes', headers: { authorization: 'Basic synthetic-private-token' }, status: 401 },
      { path: '/api/v1/quotes', headers: { authorization: 'Bearer ' + 'a'.repeat(8193) }, status: 401 },
      { path: '/api/v1/me/quotes', headers: { origin }, status: 401 },
      { path: '/api/v1/me/quotes', headers: { origin, cookie: '__Host-solventa-session=' + 'a'.repeat(16385) }, status: 401 },
      { path: '/api/v1/me/quotes', headers: { origin: 'https://' + 'a'.repeat(257) + '.invalid', cookie: '__Host-solventa-session=sealed-cookie' }, status: 403 },
    ];
    for (const item of cases) {
      const response = await app.request(origin + item.path, { method: 'POST', headers: { ...item.headers,
        'X-Trace-Id': '50000000-0000-0000-7000-000000000001' }, body: '{}' }, env);
      assert.equal(response.status, failing ? 503 : item.status, item.path);
      const body = await response.json();
      assert.deepEqual(Object.keys(body).sort(), ['error', 'traceId']);
      assert.equal(body.error, failing ? 'access_unavailable' : item.status === 403 ? 'forbidden' : 'unauthorized');
      assert.equal(response.headers.get('x-trace-id'), body.traceId);
      assert.notEqual(body.traceId, '50000000-0000-0000-7000-000000000001');
      if (!failing) assert.equal(events.at(-1)?.correlationId, body.traceId);
    }
    assert.equal(events.length, failing ? 0 : cases.length);
    assert.equal(requests.length, cases.length, 'every HTTP attempt reaches the bounded Identity request');
    assert.equal(store.saved.length, 0, 'no quote persistence is invoked after denied or unrecordable access');
    for (const value of requests) {
      const request = value as { token?: string; cookie?: string; origin?: string };
      assert.ok((request.token?.length ?? 0) <= 8192 && (request.cookie?.length ?? 0) <= 16384 && (request.origin?.length ?? 0) <= 256);
    }
    assert.ok(!JSON.stringify(events).includes('synthetic-private'));
  }
});
