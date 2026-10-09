import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../apps/web/worker/index';

function environment(name: string, contentType = 'application/json', body = '{"openapi":"3.0.3"}') {
  const requests: Request[] = [];
  const env = {
    APP_ENV: name,
    ASSETS: { fetch: async (request: Request) => { requests.push(request); return new Response(body, { headers: { 'content-type': contentType } }); } },
    ACQUISITION: { fetch: () => { throw new Error('Documentation must never invoke Acquisition'); } },
    IDENTITY: { fetch: () => { throw new Error('Documentation must never invoke Identity'); } },
  } as never;
  return { env, requests };
}

test('each environment publishes the same public documentation routes without invoking business services', async () => {
  for (const name of ['local', 'dev', 'staging', 'prod']) {
    for (const path of ['/api/docs/catalog.json', '/api/docs/v1/quotes.json', '/api/docs/v1/identity-access.json']) {
      const { env, requests } = environment(name);
      const response = await worker.fetch(new Request(`https://web.example${path}`), env);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-solventa-environment'), name);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.match(response.headers.get('content-security-policy') ?? '', /connect-src 'self'/);
      assert.deepEqual(await response.json(), { openapi: '3.0.3' });
      assert.equal(new URL(requests[0].url).pathname, path);
    }
  }
});

test('the viewer is publicly readable and the entry URL redirects to its canonical directory', async () => {
  const { env, requests } = environment('dev', 'text/html', '<!doctype html><title>Solventa API</title>');
  const redirect = await worker.fetch(new Request('https://web.example/api/docs'), env);
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), 'https://web.example/api/docs/');
  assert.equal(requests.length, 0);
  const response = await worker.fetch(new Request('https://web.example/api/docs/'), env);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Solventa API/);
});

test('unknown documentation paths and missing specifications return 404 instead of the product SPA', async () => {
  const { env, requests } = environment('dev', 'text/html', '<html>Product application</html>');
  for (const path of ['/api/docs/v9/missing.json', '/api/docs/viewer.js', '/api/docs/private.json', '/api/docs/nested/secret', '/api/docs-other']) {
    const response = await worker.fetch(new Request(`https://web.example${path}`), env);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(await response.text(), /Product application/);
  }
  assert.equal(requests.length, 2, 'only recognized documentation assets reach the asset binding');
});

test('documentation rejects writes before fetching assets and HEAD omits the asset body', async () => {
  const { env, requests } = environment('prod');
  const response = await worker.fetch(new Request('https://web.example/api/docs/v1/quotes.json', { method: 'POST', body: '{}' }), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
  assert.equal(requests.length, 0);
  const head = await worker.fetch(new Request('https://web.example/api/docs/v1/quotes.json', { method: 'HEAD' }), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('bundled fonts and their license are public read-only assets with no-store and no SPA fallback', async () => {
  const files = [
    'IBMPlexSans-Regular.woff2', 'IBMPlexSans-Medium.woff2', 'IBMPlexSans-SemiBold.woff2',
    'IBMPlexSans-Bold.woff2', 'IBMPlexMono-Regular.woff2', 'IBMPlexMono-SemiBold.woff2', 'LICENSE.txt',
  ];
  for (const file of files) {
    const type = file.endsWith('.woff2') ? 'font/woff2' : 'text/plain';
    const { env, requests } = environment('dev', type, 'asset bytes');
    const url = `https://web.example/api/docs/fonts/${file}`;
    const response = await worker.fetch(new Request(url), env);
    assert.equal(response.status, 200, file);
    assert.equal(response.headers.get('content-type'), type);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-solventa-environment'), 'dev');
    assert.equal(await response.text(), 'asset bytes');
    const head = await worker.fetch(new Request(url, { method: 'HEAD' }), env);
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const rejected = await worker.fetch(new Request(url, { method: 'POST' }), env);
    assert.equal(rejected.status, 405);
    assert.equal(requests.length, 2, 'writes must not fetch the asset');
    const missing = environment('dev', 'text/html', '<html>Product application</html>');
    assert.equal((await worker.fetch(new Request(url), missing.env)).status, 404, 'SPA fallback must not masquerade as a font');
  }
  const unknown = environment('dev', 'font/woff2', 'asset bytes');
  assert.equal((await worker.fetch(new Request('https://web.example/api/docs/fonts/unknown.woff2'), unknown.env)).status, 404);
  assert.equal(unknown.requests.length, 0);
});
