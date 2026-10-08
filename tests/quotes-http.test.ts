import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { createHttp } from '../backend/acquisition-risk/src/adapters/inbound/http';
import { HmacProtector } from '../backend/acquisition-risk/src/adapters/outbound/hmac-protector';
import { CreateQuote } from '../backend/acquisition-risk/src/application/create-quote';
import { InMemoryAccess, MemoryStore, protector } from './support/quote-fakes';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const examples = JSON.parse(read('../packages/contracts/examples/quotes.json'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema({ ...parse(read('../packages/contracts/openapi/v1/common.yaml')), $id: 'https://solventa.test/v1/common.yaml' });
ajv.addSchema({ ...parse(read('../packages/contracts/openapi/v1/quotes.yaml')), $id: 'https://solventa.test/v1/quotes.yaml' });
const schema = (name: string) => {
  const check = ajv.getSchema(`https://solventa.test/v1/quotes.yaml#/components/schemas/${name}`);
  if (!check) throw new Error(`schema ${name}`);
  return check;
};

const base = examples.cases[0].request;
const now = new Date('2026-10-06T15:00:00Z');
const TRACE = '7f3c2a9e-1b4d-4c8e-9a52-0d6e8f1a3b47';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function app() {
  const store = new MemoryStore();
  const access = new InMemoryAccess();
  const useCase = new CreateQuote({ access, store, clock: { now: () => now }, protector });
  return { store, access, http: createHttp({ quotes: useCase }) };
}
type Http = ReturnType<typeof createHttp>;
type Init = { headers?: Record<string, string>; body?: unknown; raw?: string; env?: string };
const send = (http: Http, path: string, headers: Record<string, string>, init: Init) =>
  http.request(path, {
    method: 'POST',
    headers: { 'idempotency-key': 'key-1', 'content-type': 'application/json', ...headers, ...init.headers },
    body: init.raw ?? JSON.stringify(init.body ?? base)
  }, { APP_ENV: init.env ?? 'dev' } as never);
const partner = (http: Http, init: Init = {}) => send(http, '/api/v1/quotes', { authorization: 'Bearer partner-token' }, init);
const web = (http: Http, init: Init = {}) => send(http, '/api/v1/me/quotes', { cookie: '__Host-solventa-session=sealed-cookie', origin: 'https://web.example' }, init);

for (const [name, call] of [['partner', partner], ['web user', web]] as const) {
  test(`${name}: 201 returns a quote that satisfies the contract schema, in COP, with the trace id`, async () => {
    const { http } = app();
    const res = await call(http, { headers: { 'x-trace-id': TRACE.toUpperCase() } });
    assert.equal(res.status, 201);
    const body = await res.json();
    const check = schema('Quote');
    assert.ok(check(body), JSON.stringify(check.errors));
    assert.equal(body.currency, 'COP');
    assert.equal(body.premiumMonthly, 86400);
    assert.match(body.quoteId, /^COT-\d{4}-\d{5}$/);
    assert.equal(body.traceId, TRACE);
    assert.equal(res.headers.get('x-trace-id'), TRACE);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  test(`${name}: a missing or malformed trace id is replaced by a generated UUID`, async () => {
    const { http } = app();
    for (const supplied of [undefined, 'short', 'a'.repeat(32), 'zz'.repeat(16)]) {
      const res = await call(http, { headers: supplied ? { 'x-trace-id': supplied } : {} });
      assert.match(res.headers.get('x-trace-id') ?? '', UUID);
    }
  });

  test(`${name}: 200 on an identical retry, 409 when the key is reused with another request`, async () => {
    const { http, store } = app();
    assert.equal((await call(http)).status, 201);
    const replay = await call(http);
    assert.equal(replay.status, 200);
    assert.ok(schema('Quote')(await replay.json()));
    assert.equal(store.saved.length, 1);
    const conflict = await call(http, { body: { ...base, credit: { ...base.credit, amount: 1000000 } } });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error, 'idempotency_key_reused');
  });

  test(`${name}: 400 lists field errors that satisfy the contract and never echo personal data`, async () => {
    const { http, store } = app();
    const res = await call(http, { body: { ...base, customer: { ...base.customer, birthDate: '1952-03-14', documentNumber: 'ABC123' } } });
    assert.equal(res.status, 400);
    const text = await res.text();
    const body = JSON.parse(text);
    const check = schema('ValidationError');
    assert.ok(check(body), JSON.stringify(check.errors));
    assert.ok(body.errors.some((e: { code: string }) => e.code === 'age_out_of_range'));
    for (const secret of ['1952-03-14', 'ABC123', base.customer.fullName]) assert.ok(!text.includes(secret));
    assert.equal(store.saved.length, 0);
  });

  test(`${name}: 400 for malformed JSON, oversized bodies and a missing Idempotency-Key`, async () => {
    const { http } = app();
    assert.equal((await call(http, { raw: '{not json' })).status, 400);
    assert.equal((await call(http, { raw: JSON.stringify({ ...base, pad: 'x'.repeat(20000) }) })).status, 400);
    const missingKey = await call(http, { headers: { 'idempotency-key': '' } });
    assert.equal(missingKey.status, 400);
    assert.deepEqual((await missingKey.json()).errors, [{ field: 'Idempotency-Key', code: 'required' }]);
  });

  test(`${name}: Accept-Language changes the text only, never the amounts`, async () => {
    const { http } = app();
    const es = await (await call(http, { headers: { 'idempotency-key': 'a' }, body: { ...base, product: 'x' } })).json();
    const en = await (await call(http, { headers: { 'idempotency-key': 'b', 'accept-language': 'en-US' }, body: { ...base, product: 'x' } })).json();
    assert.notEqual(es.message, en.message);
    const ok = await (await call(http, { headers: { 'idempotency-key': 'c', 'accept-language': 'en-US' } })).json();
    assert.equal(ok.currency, 'COP');
  });
}

test('partner: the Bearer token is what Identity receives, and a malformed header never reaches it', async () => {
  const { http, access } = app();
  await partner(http);
  assert.deepEqual(access.calls[0], { kind: 'partner', token: 'partner-token' });
  access.calls.length = 0;
  for (const authorization of ['Basic abc', 'Bearer', 'Bearer two words', 'Bearer a b']) {
    const res = await send(http, '/api/v1/quotes', { authorization }, {});
    assert.equal(res.status, 401, authorization);
  }
  assert.equal((await send(http, '/api/v1/quotes', {}, {})).status, 401);
  assert.equal(access.calls.length, 0);
});

test('web user: the sealed cookie value, the Origin and the real method are what Identity receives', async () => {
  const { http, access } = app();
  await web(http);
  assert.deepEqual(access.calls[0], { kind: 'web', cookie: 'sealed-cookie', origin: 'https://web.example', method: 'POST' });
});

test('web user: the cookie name follows Identity (no prefix locally, __Host- elsewhere)', async () => {
  const { http, access } = app();
  assert.equal((await send(http, '/api/v1/me/quotes', { cookie: 'solventa-session=sealed-cookie' }, { env: 'local' })).status, 201);
  assert.equal((await send(http, '/api/v1/me/quotes', { cookie: '__Host-solventa-session=sealed-cookie' }, { env: 'local', headers: { 'idempotency-key': 'k2' } })).status, 401, 'the prefixed name is not accepted locally');
  assert.equal((await send(http, '/api/v1/me/quotes', { cookie: 'solventa-session=sealed-cookie' }, { env: 'prod', headers: { 'idempotency-key': 'k3' } })).status, 401, 'the unprefixed name is not accepted in prod');
  assert.equal(access.calls.length, 1, 'only the accepted cookie reached Identity');
});

test('web user: an Authorization header is rejected before anything else, so credential types never mix', async () => {
  const { http, access, store } = app();
  const res = await web(http, { headers: { authorization: 'Bearer partner-token' } });
  assert.equal(res.status, 400);
  assert.deepEqual((await res.json()).error, 'invalid_request');
  assert.equal(access.calls.length, 0);
  assert.equal(store.saved.length, 0);
});

test('web user: no cookie is a 401 without asking Identity, and a partner token is not a session', async () => {
  const { http, access } = app();
  assert.equal((await send(http, '/api/v1/me/quotes', {}, {})).status, 401);
  assert.equal((await send(http, '/api/v1/me/quotes', { cookie: 'other=1' }, {})).status, 401);
  assert.equal(access.calls.length, 0);
});

test('access errors keep their difference and match the contract: 401, 403 and 503 with only the canonical code', async () => {
  const { http, store } = app();
  const check = schema('AccessError');
  const cases: [Promise<Response>, number, string][] = [
    [send(http, '/api/v1/quotes', { authorization: 'Bearer unknown-token' }, {}), 401, 'unauthorized'],
    [send(http, '/api/v1/quotes', { authorization: 'Bearer no-scope-token' }, {}), 403, 'forbidden'],
    [send(http, '/api/v1/quotes', { authorization: 'Bearer down-token' }, {}), 503, 'access_unavailable'],
    [send(http, '/api/v1/me/quotes', { cookie: '__Host-solventa-session=expired-cookie' }, {}), 401, 'unauthorized'],
    [send(http, '/api/v1/me/quotes', { cookie: '__Host-solventa-session=forbidden-origin-cookie' }, {}), 403, 'forbidden']
  ];
  for (const [pending, status, error] of cases) {
    const res = await pending;
    assert.equal(res.status, status);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['error', 'traceId']);
    assert.equal(body.error, error);
    assert.ok(check(body), JSON.stringify(check.errors));
  }
  assert.equal(store.saved.length, 0);
});

test('only the partner entry challenges with WWW-Authenticate', async () => {
  const { http } = app();
  const partnerRes = await send(http, '/api/v1/quotes', { authorization: 'Bearer unknown-token' }, {});
  assert.equal(partnerRes.headers.get('www-authenticate'), 'Bearer realm="solventa"');
  const userRes = await send(http, '/api/v1/me/quotes', {}, {});
  assert.equal(userRes.headers.get('www-authenticate'), null);
});

test('an unexpected failure returns a generic 500 and logs without personal data', async () => {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.join(' ')); };
  try {
    const failing = { execute: async () => { throw new Error('boom 1020884771 Laura Catalina'); } } as unknown as CreateQuote;
    const res = await partner(createHttp({ quotes: failing }));
    assert.equal(res.status, 500);
    assert.deepEqual(Object.keys(await res.json()).sort(), ['error', 'message', 'traceId']);
  } finally { console.error = original; }
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes('1020884771') && !logs[0].includes('Laura'), 'log must not carry personal data');
  assert.ok(/"traceId":"[0-9a-f-]{36}"/.test(logs[0]));
});

test('a missing HMAC secret is a generic 500 and writes nothing, not a silent fallback', async () => {
  const store = new MemoryStore();
  const useCase = new CreateQuote({ access: new InMemoryAccess(), store, clock: { now: () => now }, protector: new HmacProtector('') });
  const res = await partner(createHttp({ quotes: useCase }));
  assert.equal(res.status, 500);
  assert.equal(store.saved.length, 0);
});

test('the existing health route and 404 behaviour are unchanged', async () => {
  const { http } = app();
  assert.equal((await http.request('/health', {}, {} as never)).status, 200);
  assert.equal((await http.request('/nope', {}, {} as never)).status, 404);
  assert.equal((await http.request('/api/v1/quotes', { method: 'GET' }, {} as never)).status, 404);
  assert.equal((await http.request('/api/v1/me/quotes', { method: 'GET' }, {} as never)).status, 404);
});
