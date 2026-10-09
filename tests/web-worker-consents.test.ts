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
