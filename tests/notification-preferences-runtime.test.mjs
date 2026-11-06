import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { build } = wranglerRequire('esbuild');
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');

test('public gateway forwards a notification-preferences PUT body to Identity', { timeout: 30_000 }, async () => {
  const config = JSON.parse(await readFile('apps/web/wrangler.jsonc', 'utf8'));
  const gateway = await build({ entryPoints: ['apps/web/worker/index.ts'], bundle: true, write: false,
    format: 'esm', platform: 'neutral', external: ['node:*'] });
  const runtime = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, workers: [
    { name: 'web', unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }], modules: true,
      script: gateway.outputFiles[0].text, compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags, bindings: { APP_ENV: 'local' }, serviceBindings: { IDENTITY: 'identity' } },
    { name: 'identity', modules: true, compatibilityDate: config.compatibility_date,
      script: `export default { async fetch(request) {
        if (request.headers.get('authorization') !== 'Bearer synthetic.token') return Response.json({ error: 'unauthorized' }, { status: 401 });
        try { return Response.json({ received: await request.json(), key: request.headers.get('idempotency-key') }); }
        catch { return Response.json({ error: 'invalid_request' }, { status: 400 }); }
      } };` },
  ] }));
  try {
    await runtime.ready;
    const base = await runtime.unsafeGetDirectURL('web');
    const path = new URL('/api/v1/mobile/notification-preferences', base);
    const preferences = Object.fromEntries(['policy', 'payments', 'claims', 'commercial'].map(category =>
      [category, { push: category === 'policy', email: false, sms: false }]));
    const command = { expectedVersion: 0, preferences };
    const headers = { Authorization: 'Bearer synthetic.token', 'Content-Type': 'application/json',
      'Idempotency-Key': 'synthetic-command-1' };
    const response = await fetch(path, { method: 'PUT', headers, body: JSON.stringify(command) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: command, key: 'synthetic-command-1' });
    const oversized = await fetch(path, { method: 'PUT', headers,
      body: JSON.stringify({ ...command, extra: 'x'.repeat(4096) }) });
    assert.equal(oversized.status, 400, 'the gateway still rejects bodies above the Identity limit');
  } finally { await runtime.dispose(); }
});
