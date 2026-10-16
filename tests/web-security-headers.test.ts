import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import worker from '../apps/web/worker/index';

const origin = 'https://web.example';
const trace = '50000000-0000-4000-8000-000000000001';
const docsCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

function environment() {
  return {
    APP_ENV: 'staging',
    ASSETS: { fetch: async () => new Response('<html>application</html>', { headers: { 'content-type': 'text/html', etag: 'synthetic-etag' } }) },
    IDENTITY: { fetch: async () => Response.json({ error: 'unauthorized', traceId: trace }, { status: 401, headers: { 'x-trace-id': trace, 'cache-control': 'no-store' } }) },
    ACQUISITION: { fetch: async () => Response.json({ error: 'forbidden', traceId: trace }, { status: 403, headers: { 'x-trace-id': trace } }) },
  } as WebEnv;
}

function checkHeaders(response: Response) {
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const csp = response.headers.get('content-security-policy') ?? '';
  for (const directive of ["script-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) assert.ok(csp.includes(directive), directive);
  assert.doesNotMatch(csp, /unsafe-eval/);
}

test('SPA documents and bundles receive browser protections before returning assets', async () => {
  for (const path of ['/', '/robots.txt', '/sitemap.xml', '/assets/app.js', '/assets/app.css', '/privacy']) {
    const response = await worker.fetch(new Request(origin + path), environment());
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '<html>application</html>');
    assert.equal(response.headers.get('etag'), 'synthetic-etag');
    checkHeaders(response);
    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /style-src 'self';/);
    assert.match(csp, /font-src 'self';/);
    assert.doesNotMatch(csp, /https?:/);
    assert.doesNotMatch(csp, /unsafe-inline/);
  }
});

test('every asset request executes the gateway instead of bypassing its response protections', () => {
  const config = JSON.parse(readFileSync('apps/web/wrangler.jsonc', 'utf8'));
  assert.equal(config.assets.run_worker_first, true);
  for (const env of Object.values(config.env) as { assets?: unknown }[]) assert.equal(env.assets, undefined, 'environment inherits the protected asset routing');
});

test('health, access denials, unknown APIs and dependency failures retain their status and correlation', async () => {
  for (const [path, status] of [['/health', 200], ['/api/v1/access/web', 401], ['/api/v1/me/quotes', 403], ['/api/v1/unknown', 404], ['/internal/infra', 401]] as const) {
    const response = await worker.fetch(new Request(origin + path), environment());
    assert.equal(response.status, status);
    checkHeaders(response);
    if (path === '/api/v1/access/web' || path === '/api/v1/me/quotes') {
      assert.equal(response.headers.get('x-trace-id'), trace);
      assert.equal((await response.json()).traceId, trace);
    }
  }
  const env = environment();
  env.IDENTITY.fetch = async () => { throw new Error('synthetic dependency unavailable'); };
  const response = await worker.fetch(new Request(origin + '/api/v1/access/web', { headers: { 'x-trace-id': trace } }), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'access_unavailable', traceId: trace });
  checkHeaders(response);
});

test('OAuth redirects keep their target and both sealed cookies after response hardening', async () => {
  const env = environment();
  const cookies = ['__Host-solventa-session=synthetic; Path=/; Secure; HttpOnly; SameSite=Lax', '__Host-solventa-login=; Path=/; Secure; HttpOnly; Max-Age=0'];
  env.IDENTITY.fetch = async () => {
    const headers = new Headers({ location: 'https://auth.example/authorize?state=synthetic', 'cache-control': 'no-store' });
    for (const cookie of cookies) headers.append('set-cookie', cookie);
    return new Response(null, { status: 302, headers });
  };
  const response = await worker.fetch(new Request(origin + '/auth/login'), env);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://auth.example/authorize?state=synthetic');
  assert.deepEqual(response.headers.getSetCookie(), cookies);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), '');
  checkHeaders(response);
});

test('HTTP development responses never instruct the browser to upgrade future requests', async () => {
  const env = environment();
  for (const path of ['/', '/health', '/auth/session', '/api/v1/access/web', '/api/docs/unknown']) {
    const response = await worker.fetch(new Request('http://localhost:8787' + path), env);
    assert.equal(response.headers.get('strict-transport-security'), null);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('all API documentation results retain the restrictive viewer policy including redirects and errors', async () => {
  for (const [path, method, status] of [['/api/docs/', 'GET', 200], ['/api/docs', 'GET', 308], ['/api/docs/unknown', 'GET', 404], ['/api/docs/', 'POST', 405], ['/api/docs/', 'HEAD', 200]] as const) {
    const response = await worker.fetch(new Request(origin + path, { method }), environment());
    assert.equal(response.status, status);
    assert.equal(response.headers.get('content-security-policy'), docsCsp);
    checkHeaders(response);
    if (method === 'HEAD') assert.equal(await response.text(), '');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('self-hosted fonts retain the complete approved families, weights, subsets and licenses', () => {
  const directory = 'packages/assets/fonts/web/';
  const manifest = JSON.parse(readFileSync(directory + 'manifest.json', 'utf8'));
  const css = readFileSync(directory + 'fonts.css', 'utf8');
  const faces = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(match => match[1]);
  const expected = new Map([['IBM Plex Mono', ['400', '500', '600']], ['IBM Plex Sans', ['400', '500', '600']], ['Space Grotesk', ['500', '600', '700']]]);
  assert.equal(faces.length, 42);
  for (const [family, weights] of expected) {
    const familyFaces = faces.filter(face => face.includes(`font-family: '${family}'`));
    assert.deepEqual([...new Set(familyFaces.map(face => /font-weight: (\d+)/.exec(face)?.[1]))].sort(), weights);
    assert.equal(familyFaces.length, family === 'IBM Plex Sans' ? 18 : family === 'IBM Plex Mono' ? 15 : 9);
  }
  for (const face of faces) {
    assert.match(face, /font-display: swap/);
    assert.match(face, /font-style: normal/);
    assert.match(face, /unicode-range: U\+/);
  }
  const urls = [...new Set([...css.matchAll(/url\(\.\/([^)]+)\)/g)].map(match => match[1]))].sort();
  assert.equal(urls.length, 24);
  assert.deepEqual(urls, manifest.files.map((file: { file: string }) => file.file).sort());
  for (const file of [...manifest.files, ...manifest.licenses]) {
    const bytes = readFileSync(directory + file.file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    if (file.file.endsWith('.woff2')) assert.equal(bytes.subarray(0, 4).toString(), 'wOF2');
    else assert.ok(css.includes(bytes.toString().replace(/\r\n?/g, '\n')), 'the bundled CSS must retain the complete license');
  }
  const html = readFileSync('apps/web/index.html', 'utf8');
  assert.doesNotMatch(html + css, /https:\/\/fonts\.(googleapis|gstatic)\.com/);
  assert.match(readFileSync('apps/web/src/main.tsx', 'utf8'), /import '@solventa\/assets\/fonts\/web.css'/);
});

test('workerd applies the real asset routing and preserves binding redirects with repeated cookies', { timeout: 30000 }, async t => {
  const require = createRequire(import.meta.url);
  const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
  const { build } = wranglerRequire('esbuild');
  const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
  const config = JSON.parse(readFileSync('apps/web/wrangler.jsonc', 'utf8'));
  const directory = mkdtempSync(join(tmpdir(), 'solventa-security-headers-'));
  const html = '<!doctype html><title>Synthetic asset routing fixture</title>';
  mkdirSync(join(directory, 'assets'));
  mkdirSync(join(directory, 'api/docs'), { recursive: true });
  writeFileSync(join(directory, 'index.html'), html);
  writeFileSync(join(directory, 'assets/app.js'), 'export const synthetic = true;');
  writeFileSync(join(directory, 'api/docs/index.html'), '<html>synthetic API viewer</html>');
  const bundle = await build({ entryPoints: ['apps/web/worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:crypto'] });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', port: 0,
    workers: [
      { name: 'gateway', modules: true, script: bundle.outputFiles[0].text,
        compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
        bindings: { APP_ENV: 'staging' }, serviceBindings: { IDENTITY: 'identity' },
        assets: { directory, binding: config.assets.binding, run_worker_first: config.assets.run_worker_first,
          routerConfig: { has_user_worker: true },
          assetConfig: { not_found_handling: config.assets.not_found_handling } } },
      { name: 'identity', modules: true, compatibilityDate: config.compatibility_date,
        script: `export default { fetch() {
          const headers = new Headers({location: 'https://auth.example/authorize?state=synthetic'});
          headers.append('set-cookie', '__Host-solventa-session=synthetic; Path=/; Secure; HttpOnly');
          headers.append('set-cookie', '__Host-solventa-login=; Path=/; Secure; HttpOnly; Max-Age=0');
          return new Response(null, {status: 302, headers});
        }};` },
    ],
  }));
  t.after(async () => {
    await runtime.dispose();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir(), 'solventa-security-headers-')));
    rmSync(directory, { recursive: true });
  });
  await runtime.ready;
  for (const path of ['/', '/robots.txt', '/sitemap.xml', '/assets/app.js', '/privacy']) {
    const response = await runtime.dispatchFetch(origin + path);
    assert.equal(response.status, 200, path + ': ' + await response.clone().text());
    checkHeaders(response);
    assert.equal(await response.text(), path === '/assets/app.js' ? 'export const synthetic = true;' : html);
  }
  const documentation = await runtime.dispatchFetch(origin + '/api/docs/');
  checkHeaders(documentation);
  assert.equal(documentation.headers.get('content-security-policy'), docsCsp);
  const redirect = await runtime.dispatchFetch(origin + '/auth/login', { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'https://auth.example/authorize?state=synthetic');
  assert.deepEqual(redirect.headers.getSetCookie(), ['__Host-solventa-session=synthetic; Path=/; Secure; HttpOnly', '__Host-solventa-login=; Path=/; Secure; HttpOnly; Max-Age=0']);
  checkHeaders(redirect);
  const local = await runtime.dispatchFetch('http://localhost:8787/health');
  assert.equal(local.headers.get('strict-transport-security'), null);
});
