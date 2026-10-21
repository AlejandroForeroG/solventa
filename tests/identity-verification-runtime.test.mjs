import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { build } = wranglerRequire('esbuild');
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = wranglerRequire('miniflare');

test('workerd forwards native onboarding JSON and completes evaluation across the real gateway binding', { timeout: 30_000 }, async () => {
  const config = JSON.parse(await readFile('apps/web/wrangler.jsonc', 'utf8'));
  const gateway = await build({ entryPoints: ['apps/web/worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*'] });
  // Real routes, policy, application and provider; explicit SQL/WorkOS test doubles, never native/SQL evidence.
  const identity = await build({ stdin: { contents: `
    import { verificationHttpSetup } from './tests/support/identity-verification-http';
    let world;
    export default { fetch: (request, env) => { world ??= verificationHttpSetup(); return world.app.fetch(request, env); } };
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*'] });
  const errors = [];
  class CaptureLog extends Log { constructor() { super(LogLevel.ERROR); } error(error) { errors.push(String(error)); } }
  const runtime = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, log: new CaptureLog(), workers: [
    { name: 'web', unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }], modules: true, script: gateway.outputFiles[0].text,
      compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags, serviceBindings: { IDENTITY: 'identity' }, bindings: { APP_ENV: 'local' } },
    { name: 'identity', modules: true, script: identity.outputFiles[0].text, compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags },
  ] }));
  try {
    await runtime.ready;
    const base = await runtime.unsafeGetDirectURL('web');
    const path = '/api/v1/mobile/identity-verifications';
    async function call(suffix, method = 'GET', body, authorized = true) {
      const traceId = randomUUID();
      const response = await fetch(new URL(path + suffix, base), { method,
        headers: { 'X-Trace-Id': traceId, ...(authorized ? { Authorization: 'Bearer synthetic.jwt.token' } : {}),
          ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(7000) });
      const data = await response.json();
      assert.equal(data.traceId, traceId); assert.equal(response.headers.get('x-trace-id'), traceId);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return { status: response.status, ...data };
    }
    assert.equal((await call('')).verification, null);
    const fixtures = (await call('/fixtures')).fixtures;
    let view = (await call('', 'POST', { textVersion: 1, locale: 'es-CO' })).verification;
    assert.ok(view, 'gateway must preserve the consent JSON body');
    for (const reference of ['document-readable', 'selfie-matched', 'liveness-passed']) {
      const fixture = fixtures.find(item => item.reference === reference);
      const result = await call(`/${view.id}/steps/${fixture.step}`, 'PUT', { reference: fixture.reference, sha256: fixture.sha256,
        corpusVersion: fixture.corpusVersion, expectedVersion: view.version });
      assert.equal(result.status, 200); view = result.verification;
    }
    const evaluated = await call(`/${view.id}/evaluate`, 'POST', { expectedVersion: view.version });
    assert.equal(evaluated.status, 200); assert.equal(evaluated.verification.status, 'approved');
    assert.equal(evaluated.verification.result.simulated, true);
    assert.equal((await call(`/${view.id}/revoke`, 'POST', {})).verification.status, 'revoked');
    const oversized = { images: 'x'.repeat(4096) };
    assert.equal((await call('', 'POST', oversized)).status, 400);
    assert.equal((await call('', 'POST', oversized, false)).status, 401, 'owner authentication precedes invalid-body response');
    assert.equal((await call('')).verification.status, 'revoked');
  } finally { await runtime.dispose(); }
  assert.deepEqual(errors, [], 'binding cleanup must not throw after a response');
});
