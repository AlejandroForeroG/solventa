import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../apps/web/worker/index';

function run(path: string, init: RequestInit = {}) {
  const seen: Request[] = [];
  const env = { APP_ENV: 'local', ACQUISITION: { fetch: async (r: Request) => { seen.push(r); return Response.json({ ok: true }, { status: 201 }); } }, ASSETS: { fetch: async () => new Response('asset') } } as never;
  return worker.fetch(new Request('https://web.example' + path, init), env).then(response => ({ response, seen }));
}

test('partner quotes reach Acquisition with the Authorization header untouched', async () => {
  const { response, seen } = await run('/api/v1/quotes', { method: 'POST', body: '{}', headers: { authorization: 'Bearer partner-token' } });
  assert.equal(response.status, 201);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.get('authorization'), 'Bearer partner-token');
});

test('web quotes reach Acquisition with the session cookie and Origin untouched, and no credential is added', async () => {
  const { seen } = await run('/api/v1/me/quotes', { method: 'POST', body: '{}', headers: { cookie: '__Host-solventa-session=sealed', origin: 'https://web.example' } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.get('cookie'), '__Host-solventa-session=sealed');
  assert.equal(seen[0].headers.get('origin'), 'https://web.example');
  assert.equal(seen[0].headers.get('authorization'), null, 'the Worker never invents a credential');
});

test('quote sub-paths are forwarded but look-alike paths are not', async () => {
  assert.equal((await run('/api/v1/quotes/COT-2026-00001')).seen.length, 1);
  assert.equal((await run('/api/v1/me/quotes/COT-2026-00001')).seen.length, 1);
  for (const path of ['/api/v1/quotes-other', '/api/v1/quotesx', '/api/v1/quote', '/api/v1/me/quotes-other', '/api/v1/me', '/api/v1/me/other']) {
    const { response, seen } = await run(path, { method: 'POST', body: '{}' });
    assert.equal(seen.length, 0, path);
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: 'not_implemented' }, path);
  }
});

test('other /api paths stay unimplemented and static assets are untouched', async () => {
  assert.equal((await run('/api/other')).response.status, 404);
  assert.equal(await (await run('/')).response.text(), 'asset');
});

test('a failing Acquisition binding preserves a valid trace id without leaking details', async () => {
  const env = { APP_ENV: 'local', ACQUISITION: { fetch: async () => { throw new Error('binding exploded at 10.0.0.7 with token abc'); } } } as never;
  for (const path of ['/api/v1/quotes', '/api/v1/me/quotes']) {
    const traceId = '50000000-0000-4000-8000-000000000001';
    const response = await worker.fetch(new Request('https://web.example' + path, { method: 'POST', body: '{}', headers: { 'x-trace-id': traceId } }), env);
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(response.status, 503);
    assert.equal(body.error, 'service_unavailable');
    assert.equal(response.headers.get('x-trace-id'), body.traceId);
    assert.equal(body.traceId, traceId);
    assert.deepEqual(Object.keys(body).sort(), ['error', 'traceId']);
    assert.ok(!/10\.0\.0\.7|token|exploded/.test(text));
  }
});

test('the quote response keeps the backend body, status and trace header', async () => {
  const env = { APP_ENV: 'local', ACQUISITION: { fetch: async () => Response.json({ quoteId: 'COT-2026-00001' }, { status: 201, headers: { 'x-trace-id': 'trace-from-backend' } }) } } as never;
  const response = await worker.fetch(new Request('https://web.example/api/v1/me/quotes', { method: 'POST', body: '{}' }), env);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-trace-id'), 'trace-from-backend');
  assert.deepEqual(await response.json(), { quoteId: 'COT-2026-00001' });
});

test('the Identity access probes are still routed to Identity, not to Acquisition', async () => {
  const seen: string[] = [];
  const env = {
    APP_ENV: 'local',
    ACQUISITION: { fetch: async () => { seen.push('acquisition'); return new Response('x'); } },
    IDENTITY: { fetch: async () => { seen.push('identity'); return Response.json({ ok: true }); } }
  } as never;
  await worker.fetch(new Request('https://web.example/api/v1/access/web'), env);
  assert.deepEqual(seen, ['identity']);
});
