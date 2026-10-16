import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

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
      consents: { revoke: async input => input.consentCode === 'CNS-2026-99999'
        ? { status: 'not_found' } : { status: 'revoked', consent: { status: 'revoked' } } }
    });
    export default { fetch: (request, env) => app.fetch(request, env) };
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'neutral' });
  const errors = [];
  class CaptureLog extends Log {
    constructor() { super(LogLevel.ERROR); }
    error(error) { errors.push(String(error)); }
  }
  const runtime = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', port: 0, log: new CaptureLog(),
    handleStructuredLogs: event => { if (event.level === 'error') errors.push(event.message); },
    workers: [
      { name: 'gateway', unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }], modules: true, script: gateway.outputFiles[0].text, compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags, bindings: { APP_ENV: 'local' }, serviceBindings: { IDENTITY: 'consents' } },
      { name: 'consents', modules: true, script: consent.outputFiles[0].text, compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags, bindings: { APP_ENV: 'local' } }
    ]
  }));
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
    if (url.searchParams.get('mode') === 'success') return Response.json({ actor: { kind: 'user' } });
    const state = { started: true, aborted: false };
    calls.set(id, state);
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(new Response('late')), 15000);
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

});
