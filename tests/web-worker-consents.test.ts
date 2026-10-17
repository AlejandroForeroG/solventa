import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../apps/web/worker/index';

function run(path: string, init: RequestInit = {}, identity?: (request: Request) => Promise<Response>) {
  const seen: Request[] = [];
  const env = {
    APP_ENV: 'local',
    IDENTITY: { fetch: async (request: Request) => { seen.push(request); return identity ? identity(request) : Response.json({ ok: true }); } },
    ACQUISITION: { fetch: async () => assert.fail('consents never go to Acquisition') },
    ASSETS: { fetch: async () => new Response('asset') }
  } as never;
  return worker.fetch(new Request('https://web.example' + path, init), env).then(response => ({ response, seen }));
}

test('consent routes reach Identity with the cookie, Origin and Idempotency-Key untouched', async () => {
  const { response, seen } = await run('/api/v1/consents', { method: 'POST', body: '{}', headers: { cookie: 'solventa-session=sealed', origin: 'https://web.example', 'idempotency-key': 'k' } });
  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.get('cookie'), 'solventa-session=sealed');
  assert.equal(seen[0].headers.get('origin'), 'https://web.example');
  assert.equal(seen[0].headers.get('idempotency-key'), 'k');
});

test('every consent path is forwarded and look-alike paths are not', async () => {
  for (const path of ['/api/v1/consents', '/api/v1/consents/terms', '/api/v1/consents/declines', '/api/v1/consents/CNS-2026-00001/revoke']) assert.equal((await run(path)).seen.length, 1, path);
  for (const path of ['/api/v1/consentsx', '/api/v1/consent', '/api/v1/consents-other']) {
    const { response, seen } = await run(path);
    assert.equal(seen.length, 0, path);
    assert.equal(response.status, 404, path);
  }
});

test('an unavailable Identity becomes a safe 503 with a trace id and no internal detail', async () => {
  const { response } = await run('/api/v1/consents', { method: 'POST', body: '{}' }, async () => { throw new Error('binding exploded at 10.0.0.7'); });
  const text = await response.text();
  const body = JSON.parse(text);
  assert.equal(response.status, 503);
  assert.equal(body.error, 'access_unavailable');
  assert.equal(response.headers.get('x-trace-id'), body.traceId);
  assert.ok(!/10\.0\.0\.7|exploded/.test(text));
});

test('a failed upload reader returns a correlated 503 without calling Identity or exposing its cause', async () => {
  let calls = 0;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(Error('synthetic-private-upload-failure')); } });
  const init = { method: 'POST', body, duplex: 'half', headers: { 'x-trace-id': '50000000-0000-4000-8000-000000000001' } };
  const response = await worker.fetch(new Request('https://web.example/api/v1/consents', init), { IDENTITY: { fetch: async () => { calls++; return new Response(); } } } as never);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'access_unavailable', traceId: '50000000-0000-4000-8000-000000000001' });
  assert.equal(calls, 0);
});

test('transport caps match the owner and replace oversized bytes without forwarding their data or length', async () => {
  for (const [path, limit, owner] of [
    ['/api/v1/consents', 4096, 'IDENTITY'], ['/api/v1/me/quotes', 16384, 'ACQUISITION'],
    ['/api/v1/quote-estimates', 16384, 'ACQUISITION'], ['/api/v1/offers', 1024, 'ACQUISITION'],
    ['/api/v1/quotes/COT-2026-00001/offers', 1024, 'ACQUISITION'], ['/api/v1/policies/policy/issue', 1024, 'POLICY']
  ] as const) {
    let received = '';
    const payload = 'x'.repeat(limit);
    const env = { [owner]: { fetch: async (request: Request) => {
      received = await request.text();
      assert.equal(request.headers.get('content-type'), 'application/json');
      assert.equal(request.headers.get('cookie'), 'solventa-session=synthetic-session');
      return Response.json({ received: received.length });
    } } } as never;
    let response = await worker.fetch(new Request('https://web.example' + path, { method: 'POST', body: payload, headers: { cookie: 'solventa-session=synthetic-session', 'content-type': 'application/json' } }), env);
    assert.equal(response.status, 200); assert.equal(received, payload, 'the exact owner limit must pass unchanged');
    const oversizedEnv = { [owner]: { fetch: async (request: Request) => {
      assert.equal(request.headers.get('content-length'), null);
      assert.equal(await request.text(), '{', 'no rejected input bytes cross the binding');
      return new Response(null, { status: 401 });
    } } } as never;
    response = await worker.fetch(new Request('https://web.example' + path, { method: 'POST', body: payload + 'synthetic-private-marker', headers: { 'content-type': 'application/json', 'content-length': String(limit + 24) } }), oversizedEnv);
    assert.equal(response.status, 401, 'the gateway preserves the owner decision before JSON validation');
  }
});
