import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { build } = wranglerRequire('esbuild');
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');

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

test('workerd Identity-first rollout preserves legacy RPC writes before Acquisition sends requestOrigin', { timeout: 30000 }, async t => {
  // The real composition root, HTTP adapters and access policy run in workerd.
  // Provider authentication, session lookup and denial persistence are fakes; the SQL driver rejects any accidental query.
  const stubs = {
    'workos-authentication': `export class WorkosAuthentication {
      async authenticate(cookie) { return cookie === 'synthetic-session' ? { identity: { providerSubject: 'user_synthetic', sessionReference: 'session_synthetic', emailVerified: true } } : null; }
    }`,
    'identity-sessions': `export class SqlIdentitySessions {
      async find() { return { clientId: '30000000-0000-4000-8000-000000000001', subjectToken: '40000000-0000-4000-8000-000000000001' }; }
    }`,
    'sql-security-decisions': `export class SqlSecurityDecisions { async append() {} }`,
    pg: `export class Pool { query() { throw new Error('unexpected_sql_query'); } connect() { throw new Error('unexpected_sql_connection'); } } export class Client extends Pool {}`,
  };
  const bundle = await build({
    entryPoints: ['backend/identity-consent-ecosystem/src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:workers', 'node:*'],
    plugins: [{ name: 'synthetic-provider-and-sessions', setup(builder) {
      builder.onResolve({ filter: /\/(workos-authentication|identity-sessions|sql-security-decisions)$/ }, args => ({ path: args.path.split('/').at(-1), namespace: 'synthetic' }));
      builder.onResolve({ filter: /^pg$/ }, () => ({ path: 'pg', namespace: 'synthetic' }));
      builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, args => ({ contents: stubs[args.path], loader: 'js' }));
    } }],
  });
  const canonical = 'https://dev.solventa.site';
  const legacy = 'https://solventa-web-dev.ja-forerog1.workers.dev';
  const config = JSON.parse(await readFile('backend/identity-consent-ecosystem/wrangler.jsonc', 'utf8'));
  const runtime = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', port: 0,
    workers: [
      { name: 'identity-domain-rollout', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
        bindings: { APP_ENV: 'dev', AUTH_ORIGIN: canonical, AUTH_REDIRECT_URI: canonical + '/auth/callback', WORKOS_API_KEY: 'sk_synthetic', WORKOS_CLIENT_ID: 'client_synthetic', AUTH_COOKIE_PASSWORD: 'a'.repeat(64), IDENTITY_DB: { connectionString: 'postgresql://synthetic.invalid/unused' } } },
      { name: 'caller', modules: true, compatibilityDate: config.compatibility_date, script: `export default { async fetch(request, env) { return Response.json(await env.IDENTITY.authorizeApiAccessV1(await request.json())); } };`,
        serviceBindings: { IDENTITY: 'identity-domain-rollout' } },
    ],
  }));
  t.after(() => runtime.dispose());
  await runtime.ready;
  const caller = await runtime.getWorker('caller');
  const authorize = async input => (await caller.fetch('http://caller/authorize', { method: 'POST', body: JSON.stringify({ kind: 'web', cookie: 'synthetic-session', method: 'POST', operation: 'quotes:create', ...input }) })).json();

  assert.equal((await authorize({ origin: legacy })).allowed, true, 'the previous Acquisition release remains authorized after Identity changes AUTH_ORIGIN');
  assert.deepEqual(await authorize({ origin: canonical }), { allowed: false, error: 'forbidden', status: 403 }, 'old callers do not acquire the canonical alias implicitly');
  for (const host of [canonical, legacy]) {
    assert.equal((await authorize({ origin: host, requestOrigin: host })).allowed, true);
    assert.deepEqual(await authorize({ origin: host === canonical ? legacy : canonical, requestOrigin: host }), { allowed: false, error: 'forbidden', status: 403 });
  }
  assert.deepEqual(await authorize({ origin: 'https://staging.solventa.site', requestOrigin: 'https://staging.solventa.site' }), { allowed: false, error: 'forbidden', status: 403 });
});
