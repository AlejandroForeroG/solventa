import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { build } = wranglerRequire('esbuild');
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const { Log, LogLevel } = wranglerRequire('miniflare');

test('workerd consent responses finish unused uploads without background stream exceptions', { timeout: 30000 }, async () => {
  // The real gateway and consent HTTP adapter run across a Service Binding; business/authentication collaborators are synthetic.
  const config = JSON.parse(await readFile('apps/web/wrangler.jsonc', 'utf8'));
  const gateway = await build({ entryPoints: ['apps/web/worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:crypto'] });
  const consent = await build({ stdin: { contents: `
    import { Hono } from 'hono';
    import { mountConsents } from './backend/identity-consent-ecosystem/src/adapters/inbound/consents-http';
    const app = new Hono();
    mountConsents(app, {
      authorizeApiAccess: async input => input.cookie === 'synthetic-session'
        ? { allowed: true, actor: { kind: 'user', principal: {} } }
        : { allowed: false, error: 'unauthorized', status: 401 },
      consents: { grant: async input => input.body ? { status: 'created', consent: { status: 'active' } } : { status: 'invalid' }, revoke: async input => input.consentCode === 'CNS-2026-99999'
        ? { status: 'not_found' } : { status: 'revoked', consent: { status: 'revoked' } } }
    });
    export default { fetch: (request, env) => app.fetch(request, env) };
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'neutral' });
  const errors = [];
  class CaptureLog extends Log {
    constructor() { super(LogLevel.ERROR); }
    error(error) { errors.push(String(error)); }
  }
  const options = convertV4MiniflareOptions({
    host: '127.0.0.1', port: 0, log: new CaptureLog(),
    handleStructuredLogs: event => { if (event.level === 'error') errors.push(event.message); },
    workers: [
      { name: 'gateway', unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }], modules: true, script: gateway.outputFiles[0].text, compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags, bindings: { APP_ENV: 'local' }, serviceBindings: { IDENTITY: 'consents' } },
      { name: 'consents', modules: true, script: consent.outputFiles[0].text, compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags, bindings: { APP_ENV: 'local' } },
      { name: 'capture', modules: true, script: `let events=[]; export default { async tail(batch) { events.push(...batch.map(event=>({outcome:event.outcome,exceptions:event.exceptions}))); }, fetch() { return Response.json(events); } };`, compatibilityDate: config.compatibility_date }
    ]
  });
  // The V4 compatibility converter drops tailConsumers; attach it to the current runtime configuration.
  options.workers[0].config.tailConsumers = [{ worker: 'capture' }];
  const runtime = new Miniflare(options);
  try {
    await runtime.ready;
    const base = await runtime.unsafeGetDirectURL('gateway');
    for (const outcome of ['revoked', 'not_found', 'unauthorized']) {
      const consentId = outcome === 'not_found' ? 'CNS-2026-99999' : 'CNS-2026-00001';
      const response = await fetch(new URL('/api/v1/consents/' + consentId + '/revoke', base), {
        method: 'POST', body: '{}', headers: { origin: base.origin, ...(outcome !== 'unauthorized' ? { cookie: 'solventa-session=synthetic-session' } : {}) },
        signal: AbortSignal.timeout(5000)
      });
      assert.equal(response.status, outcome === 'revoked' ? 200 : outcome === 'not_found' ? 404 : 401);
      const body = await response.json();
      if (outcome === 'revoked') assert.equal(body.status, 'revoked');
      else assert.equal(body.error, outcome);
    }
    for (const authenticated of [false, true]) {
      const response = await fetch(new URL('/api/v1/consents', base), { method: 'POST', body: JSON.stringify({ synthetic: 'x'.repeat(4096) }), headers: { origin: base.origin, 'content-type': 'application/json', ...(authenticated ? { cookie: 'solventa-session=synthetic-session' } : {}) } });
      assert.equal(response.status, authenticated ? 400 : 401, 'oversized data still reaches owner authorization before JSON validation');
      assert.equal((await response.json()).error, authenticated ? 'invalid_request' : 'unauthorized');
    }
    const chunked = await new Promise((resolveChunked, reject) => {
      const upload = httpRequest(new URL('/api/v1/consents', base), { method: 'POST', headers: { origin: base.origin, cookie: 'solventa-session=synthetic-session', 'content-type': 'application/json' } }, response => { response.resume(); response.once('end', () => resolveChunked(response.statusCode)); });
      upload.on('error', reject); upload.end(JSON.stringify({ synthetic: 'x'.repeat(4096) }));
    });
    assert.equal(chunked, 400, 'unknown-length oversized uploads cannot bypass the byte cap');
    // Keep a genuine HTTP upload open while Identity rejects it before parsing.
    const started = performance.now();
    const slow = await new Promise((resolveSlow, reject) => {
      const upload = httpRequest(new URL('/api/v1/consents/CNS-2026-00001/revoke', base), { method: 'POST', headers: { origin: base.origin, 'content-type': 'application/json' } }, response => {
        response.resume(); response.once('end', () => { upload.destroy(); resolveSlow(response.statusCode); });
      });
      upload.on('error', reject); upload.setTimeout(8000, () => upload.destroy(Error('slow_upload_timeout')));
      upload.write('{');
    });
    assert.equal(slow, 503, 'the shared five-second deadline also bounds an unfinished upload');
    assert.ok(performance.now() - started >= 4500 && performance.now() - started < 7500);
    const subsequent = await fetch(new URL('/api/v1/consents/CNS-2026-00001/revoke', base), { method: 'POST', body: '{}' });
    assert.equal(subsequent.status, 401, 'a cancelled or failed upload must not poison the next request');
    await subsequent.arrayBuffer();
    const capture = await runtime.getWorker('capture');
    let events = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      events = await (await capture.fetch('http://capture/')).json();
      if (events.length >= 8) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
    assert.equal(events.length, 8, 'every gateway invocation must reach the real tail consumer');
    assert.deepEqual(events.flatMap(event => event.exceptions), [], 'gateway tail must contain no post-response exceptions');
  } finally { await runtime.dispose(); }
  assert.deepEqual(errors, [], 'no post-response request-stream exception is allowed');
});

const identity = `
const calls = new Map();
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (url.pathname === '/state') return Response.json(calls.get(id) ?? null);
    if (url.searchParams.get('mode') === 'stream') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('first-')); setTimeout(()=>{ controller.enqueue(new TextEncoder().encode('last')); controller.close(); }, 100); } }), { headers: { 'set-cookie': 'synthetic-cookie=value; HttpOnly', 'x-trace-id': 'synthetic-trace' } });
    if (url.searchParams.get('mode') === 'success') return Response.json({ actor: { kind: 'user' } });
    const state = { started: true, aborted: false };
    calls.set(id, state);
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(new Response('late')), url.searchParams.get('mode') === 'delayed' ? 3500 : 15000);
      request.signal.addEventListener('abort', () => {
        state.aborted = true;
        clearTimeout(timer);
        resolve(new Response('cancelled'));
      }, { once: true });
    });
  }
};`;

async function waitForState(worker, id, predicate) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const state = await (await worker.fetch('http://identity/state?id=' + id)).json();
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Identity did not reach the expected state within two seconds');
}

test('workerd gateway bounds stalled Identity service calls', { timeout: 30000 }, async t => {
  const config = JSON.parse(await readFile('apps/web/wrangler.jsonc', 'utf8'));
  const bundle = await build({ entryPoints: ['apps/web/worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:crypto'] });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', port: 0,
    workers: [
      { name: 'gateway', unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }], modules: true, script: bundle.outputFiles[0].text, compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags, bindings: { APP_ENV: 'local' }, serviceBindings: { IDENTITY: 'identity' } },
      { name: 'identity', modules: true, script: identity, compatibilityDate: config.compatibility_date, compatibilityFlags: ['enable_request_signal'] },
    ],
  }));
  t.after(() => runtime.dispose());
  await runtime.ready;
  // Bypass the development proxy: requests enter the actual workerd HTTP socket.
  const base = await runtime.unsafeGetDirectURL('gateway');
  const service = await runtime.getWorker('identity');

  await t.test('a responsive Identity binding returns its actual response', async () => {
    const response = await fetch(new URL('/api/v1/access/web?mode=success', base));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { actor: { kind: 'user' } });
  });

  await t.test('successful streamed responses finish after gateway cleanup without losing headers', async () => {
    const response = await fetch(new URL('/api/v1/access/web?mode=stream', base));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'first-last');
    assert.equal(response.headers.get('set-cookie'), 'synthetic-cookie=value; HttpOnly');
    assert.equal(response.headers.get('x-trace-id'), 'synthetic-trace');
    const head = await fetch(new URL('/api/v1/access/web?mode=success', base), { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
  });

  await t.test('a stalled binding is cancelled after the real five-second deadline', async () => {
    const started = performance.now();
    const trace = '50000000-0000-4000-8000-000000000001';
    const response = await fetch(new URL('/api/v1/access/partner?id=deadline', base), { headers: { 'X-Trace-Id': trace }, signal: AbortSignal.timeout(10000) });
    const elapsed = performance.now() - started;
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'access_unavailable', traceId: trace });
    assert.equal(response.headers.get('x-trace-id'), trace);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(elapsed >= 4500 && elapsed < 9000, 'expected the five-second gateway deadline');
    await waitForState(service, 'deadline', state => state?.aborted);
    t.diagnostic('real gateway deadline elapsed: ' + Math.round(elapsed) + ' ms');
  });

  await t.test('upload transport and binding share one deadline instead of receiving five seconds each', async () => {
    const started = performance.now();
    const response = await new Promise((resolveResponse, reject) => {
      const upload = httpRequest(new URL('/api/v1/consents?mode=delayed&id=shared', base), { method: 'POST' }, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
        response.once('end', () => resolveResponse({ status: response.statusCode, body: JSON.parse(body) }));
      });
      upload.on('error', reject); upload.write('{'); setTimeout(() => upload.end('}'), 2500);
    });
    assert.equal(response.status, 503); assert.equal(response.body.error, 'access_unavailable');
    assert.ok(performance.now() - started >= 4500 && performance.now() - started < 5800);
    await waitForState(service, 'shared', state => state?.aborted);
  });

});
