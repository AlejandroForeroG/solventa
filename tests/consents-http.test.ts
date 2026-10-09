import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { authorizeApiAccess } from '../backend/identity-consent-ecosystem/src/adapters/inbound/api-access-http';
import { createHttp } from '../backend/identity-consent-ecosystem/src/adapters/inbound/http';
import { HmacIntegrity } from '../backend/identity-consent-ecosystem/src/adapters/outbound/hmac-integrity';
import { ApiAccess } from '../backend/identity-consent-ecosystem/src/application/api-access';
import { Consents } from '../backend/identity-consent-ecosystem/src/application/consents';
import type { Principal } from '../backend/identity-consent-ecosystem/src/application/authentication';
import { ANA, LUIS, MemoryConsents, SEAL_KEY, TRACE, clock } from './support/consent-fakes';

const read = (path: string) => readFileSync(path, 'utf8');
const examples = JSON.parse(read('packages/contracts/examples/consents.json'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema({ ...parse(read('packages/contracts/openapi/v1/common.yaml')), $id: 'https://solventa.test/v1/common.yaml' });
ajv.addSchema({ ...parse(read('packages/contracts/openapi/v1/consents.yaml')), $id: 'https://solventa.test/v1/consents.yaml' });
const schema = (name: string) => {
  const check = ajv.getSchema(`https://solventa.test/v1/consents.yaml#/components/schemas/${name}`);
  assert.ok(check, name);
  return check;
};

const origin = 'https://solventa-web-dev.ja-forerog1.workers.dev';
const env = { APP_ENV: 'dev' } as IdentityEnv;
const people: Record<string, Principal> = { ana: ANA, luis: LUIS };
const cookie = (name: string) => `__Host-solventa-session=${name}`;

function app(key = SEAL_KEY) {
  const store = new MemoryConsents();
  const consents = new Consents({ store, platform: clock(), integrity: new HmacIntegrity(key) });
  const deps = {
    application: new ApiAccess({ find: async () => null }, { find: async identity => people[identity.providerSubject] ?? null, open: async () => assert.fail('no login here'), revoke: async () => assert.fail('no logout here') }),
    partner: null,
    web: {
      authenticate: async (value: string) => (value in people ? { identity: { providerSubject: value, sessionReference: 'session', emailVerified: true } } : null),
      allowedOrigins: [origin]
    }
  };
  return { store, http: createHttp({ authorizeApiAccess: input => authorizeApiAccess(deps, input), consents }), deps };
}
type Http = ReturnType<typeof app>['http'];
const call = (http: Http, method: string, path: string, init: { as?: string | null; headers?: Record<string, string>; body?: unknown; raw?: string } = {}) =>
  http.request(origin + path, {
    method,
    headers: {
      ...(init.as === null ? {} : { cookie: cookie(init.as ?? 'ana') }),
      ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}),
      ...init.headers
    },
    body: method === 'POST' ? init.raw ?? JSON.stringify(init.body ?? { textVersion: 1, locale: 'es-CO' }) : undefined
  }, env);
const grant = (http: Http, key = 'key-1', init: Parameters<typeof call>[3] = {}) =>
  call(http, 'POST', '/api/v1/consents', { ...init, headers: { 'idempotency-key': key, ...init.headers } });

test('the terms endpoint serves the terms of the contract example', async () => {
  const { http } = app();
  const res = await call(http, 'GET', '/api/v1/consents/terms', { headers: { 'x-trace-id': TRACE } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(schema('ConsentTerms')(body));
  assert.deepEqual({ ...body, traceId: examples.terms.traceId }, examples.terms);
  assert.equal(res.headers.get('x-trace-id'), TRACE);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('grant, replay, list and revoke answer with the contract shapes', async () => {
  const { http } = app();
  const created = await grant(http);
  assert.equal(created.status, 201);
  const consent = await created.json();
  assert.ok(schema('ConsentResponse')(consent));
  const replay = await grant(http);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).consentId, consent.consentId);

  const list = await call(http, 'GET', '/api/v1/consents');
  const listed = await list.json();
  assert.ok(schema('ConsentList')(listed), JSON.stringify(schema('ConsentList').errors));
  assert.equal(listed.items.length, 1);

  const revoked = await call(http, 'POST', `/api/v1/consents/${consent.consentId}/revoke`, { body: {} });
  assert.equal(revoked.status, 200);
  const body = await revoked.json();
  assert.ok(schema('ConsentResponse')(body));
  assert.equal(body.status, 'revoked');
  assert.equal((await (await call(http, 'POST', `/api/v1/consents/${consent.consentId}/revoke`, { body: {} })).json()).revokedAt, body.revokedAt);
});

test('declining answers 204 without a body and leaves no consent', async () => {
  const { http, store } = app();
  const res = await call(http, 'POST', '/api/v1/consents/declines', { body: { textVersion: 1 }, headers: { 'x-trace-id': TRACE } });
  assert.equal(res.status, 204);
  assert.equal(await res.text(), '');
  assert.equal(res.headers.get('x-trace-id'), TRACE);
  assert.equal(store.consents.length, 0);
  assert.equal(store.audit.length, 1);
});

test('without a valid session nothing is read or written', async () => {
  const { http, store } = app();
  for (const [method, path] of [['GET', '/api/v1/consents/terms'], ['GET', '/api/v1/consents'], ['POST', '/api/v1/consents'], ['POST', '/api/v1/consents/declines'], ['POST', '/api/v1/consents/CNS-2026-00001/revoke']] as const) {
    for (const as of [null, 'expired']) {
      const res = await call(http, method, path, { as, headers: { 'idempotency-key': 'k' } });
      assert.equal(res.status, 401, `${method} ${path} as ${as}`);
      const body = await res.json();
      assert.deepEqual(Object.keys(body).sort(), ['error', 'traceId']);
      assert.equal(body.error, 'unauthorized');
    }
  }
  assert.equal(store.consents.length + store.audit.length, 0);
});

test('a write from another origin is forbidden and an Authorization header is rejected', async () => {
  const { http, store } = app();
  const foreign = await grant(http, 'k', { headers: { origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error, 'forbidden');
  const bearer = await grant(http, 'k', { headers: { authorization: 'Bearer partner-token' } });
  assert.equal(bearer.status, 400);
  assert.equal((await call(http, 'GET', '/api/v1/consents', { headers: { authorization: 'Bearer partner-token' } })).status, 400);
  assert.equal(store.consents.length, 0);
});

test('a partner credential can never manage consent', async () => {
  const identity = { issuer: 'https://issuer.example', organizationId: 'org', applicationId: 'app', scopes: ['consents:write', 'quotes:create'] };
  const partners = new ApiAccess({ find: async () => ({ partnerId: 'p', credentialId: 'c', scopes: ['consents:write', 'quotes:create'] }) }, { find: async () => null, open: async () => assert.fail('no login'), revoke: async () => assert.fail('no logout') });
  for (const operation of ['consents:read', 'consents:write']) {
    assert.deepEqual(await partners.partner(identity, operation), { allowed: false, error: 'forbidden', status: 403 });
  }
  assert.equal((await partners.partner(identity, 'quotes:create')).allowed, true);
});

test('invalid requests are 400 and a stale text or reused key is 409', async () => {
  const { http, store } = app();
  assert.equal((await call(http, 'POST', '/api/v1/consents', { body: { textVersion: 1, locale: 'es-CO' } })).status, 400, 'missing Idempotency-Key');
  assert.equal((await grant(http, 'k', { raw: '{not json' })).status, 400);
  assert.equal((await grant(http, 'k', { body: { textVersion: 1, locale: 'es-CO', subjectToken: 'x' } })).status, 400);
  assert.equal((await grant(http, 'k', { body: { textVersion: 1 } })).status, 400, 'a grant without the language');
  assert.equal((await grant(http, 'k', { body: { textVersion: 1, locale: 'fr-FR' } })).status, 400);
  assert.equal((await call(http, 'POST', '/api/v1/consents/declines', { body: { textVersion: 'one' } })).status, 400);
  assert.equal((await call(http, 'POST', '/api/v1/consents/not-a-code/revoke', { body: {} })).status, 400);
  const outdated = await grant(http, 'k', { body: { textVersion: 2, locale: 'es-CO' } });
  assert.equal(outdated.status, 409);
  assert.equal((await outdated.json()).error, 'terms_outdated');
  assert.equal((await call(http, 'POST', '/api/v1/consents/declines', { body: { textVersion: 2 } })).status, 409);
  assert.equal(store.consents.length, 0);

  assert.equal((await grant(http, 'same')).status, 201);
  const reused = await grant(http, 'same', { body: { textVersion: 1, locale: 'es-CO', quoteRef: 'COT-2026-00009' } });
  assert.equal(reused.status, 409);
  assert.equal((await reused.json()).error, 'idempotency_key_reused');
  for (const error of ['terms_outdated', 'idempotency_key_reused']) assert.ok(schema('ConsentError')({ error, traceId: TRACE }));
});

test('an oversized body is refused without being read in full', async () => {
  const { http, store } = app();
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulled++; if (pulled > 500) controller.close(); else controller.enqueue(new Uint8Array(1024).fill(120)); } });
  const res = await http.request(origin + '/api/v1/consents', { method: 'POST', headers: { cookie: cookie('ana'), origin, 'idempotency-key': 'big' }, body: stream, duplex: 'half' } as RequestInit, env);
  assert.equal(res.status, 400);
  assert.ok(pulled < 20, `read ${pulled} KiB`);
  assert.equal(store.consents.length, 0);
});

test('a consent of another user is reported as not found, and revoking an expired one is a conflict', async () => {
  const { http, store } = app();
  const consent = await (await grant(http)).json();
  const foreign = await call(http, 'POST', `/api/v1/consents/${consent.consentId}/revoke`, { as: 'luis', body: {} });
  assert.equal(foreign.status, 404);
  assert.equal((await foreign.json()).error, 'not_found');
  assert.equal((await call(http, 'POST', '/api/v1/consents/CNS-2026-99999/revoke', { body: {} })).status, 404);
  assert.deepEqual((await (await call(http, 'GET', '/api/v1/consents', { as: 'luis' })).json()).items, []);

  store.consents[0].expiresAt = new Date('2026-01-01T00:00:00Z');
  const expired = await call(http, 'POST', `/api/v1/consents/${consent.consentId}/revoke`, { body: {} });
  assert.equal(expired.status, 409);
  assert.equal((await expired.json()).error, 'consent_not_active');
});

test('when persistence or the seal key fail the answer is 503 with no internal detail and nothing is written', async () => {
  const down = app();
  down.store.failing = true;
  const res = await grant(down.http);
  const text = await res.text();
  assert.equal(res.status, 503);
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['error', 'traceId']);
  assert.ok(!/store_down/.test(text));

  const noKey = app('short');
  assert.equal((await grant(noKey.http)).status, 503);
  assert.equal(noKey.store.consents.length, 0);
});
