import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, X509Certificate, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { owners, settings, provision, verifyIsolation } from './database.mjs';

// Development only. This account is intentionally fixed; production is not configured.
const account = '803fd559877aae8f638140610f106857';
const profile = process.env.CLOUDFLARE_PROFILE ?? 'solventa-universidad';
function caFingerprint(pem) {
  const certificates = [...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)];
  if (!certificates.length) throw Error('CA bundle is empty');
  return certificates.map(match => new X509Certificate(match[0]).fingerprint256).sort().join(',');
}
function wrangler(args, capture = false) {
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args, '--profile', profile], { windowsHide: true, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.status !== 0) throw Error('Wrangler failed');
  return result.stdout;
}
async function cloudflare() {
  const { token } = JSON.parse(wrangler(['auth', 'token', '--json'], true));
  return async (path, method = 'GET', body) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const data = await response.json();
    if (!data.success) {
      // Diagnostics exclude credential and origin values supplied to this request.
      const sensitive = [token, body?.origin?.password, body?.origin?.host, process.env.DATABASE_URL].filter(Boolean);
      const messages = data.errors?.map(e => {
        let message = e.message ?? '';
        for (const value of sensitive) message = message.replaceAll(value, '[redacted]');
        return { code: e.code, message: message.slice(0, 200) };
      });
      console.error(JSON.stringify({ cloudflareErrors: messages }));
      throw Error(`Cloudflare failed (${data.errors?.map(e => e.code).join(',')})`);
    }
    return data.result;
  };
}
async function verifyResources(api) {
  const config = await settings('dev');
  if (!config.ssl.ca) throw Error('Remote TLS verification requires DATABASE_CA_FILE');
  const expectedCA = caFingerprint(config.ssl.ca);
  const verifiedCAs = new Set();
  for (const owner of owners) {
    const worker = JSON.parse(await readFile(`backend/${owner.name}/wrangler.jsonc`, 'utf8'));
    assert.equal(worker.account_id, account);
    const resource = await api(`/hyperdrive/configs/${worker.env.dev.hyperdrive[0].id}`);
    assert.equal(resource.name, `solventa-${owner.schema}-dev`);
    assert.equal(resource.origin.host, config.url.hostname);
    assert.equal(resource.origin.database, config.database);
    assert.equal(resource.origin.user, `solventa_dev_${owner.schema}`);
    assert.equal(resource.caching.disabled, true);
    assert.equal(resource.mtls.sslmode, 'verify-full');
    assert.ok(resource.mtls.ca_certificate_id);
    if (!verifiedCAs.has(resource.mtls.ca_certificate_id)) {
      const certificate = await api(`/mtls_certificates/${resource.mtls.ca_certificate_id}`);
      assert.equal(certificate.ca, true);
      assert.equal(caFingerprint(certificate.certificates), expectedCA);
      verifiedCAs.add(resource.mtls.ca_certificate_id);
    }
    assert.equal(resource.origin_connection_limit, 5);
  }
}
async function up(api) {
  const config = await settings('dev');
  if (['localhost', '127.0.0.1'].includes(config.url.hostname)) throw Error('Remote development requires its own database origin');
  await provision('dev');
  await verifyIsolation('dev');
  const state = JSON.parse(await readFile('infra/.local/runtime.dev.json', 'utf8'));
  if (!config.ssl.ca) throw Error('Remote TLS verification requires DATABASE_CA_FILE');
  const fingerprint = caFingerprint(config.ssl.ca);
  const certificateName = `solventa-dev-ca-${createHash('sha256').update(fingerprint).digest('hex').slice(0, 32)}`;
  const certificates = await api('/mtls_certificates');
  let certificate = certificates.find(item => item.ca === true && caFingerprint(item.certificates) === fingerprint);
  if (!certificate) certificate = await api('/mtls_certificates', 'POST', { name: certificateName, certificates: config.ssl.ca, ca: true });
  const existing = await api('/hyperdrive/configs');
  for (const owner of owners) {
    const name = `solventa-${owner.schema}-dev`;
    let resource = existing.find(item => item.name === name);
    const body = {
      name,
      origin: { scheme: 'postgres', host: config.url.hostname, port: Number(config.url.port || 26257), database: config.database, user: `solventa_dev_${owner.schema}`, password: state.passwords[owner.schema] },
      mtls: { sslmode: 'verify-full', ca_certificate_id: certificate.id }, caching: { disabled: true }, origin_connection_limit: 5,
    };
    if (resource) {
      if (resource.origin?.database !== config.database || resource.origin?.user !== body.origin.user || resource.origin?.host !== body.origin.host) throw Error('Existing resource belongs to another origin');
      resource = await api(`/hyperdrive/configs/${resource.id}`, 'PUT', body);
    } else resource = await api('/hyperdrive/configs', 'POST', body);
    const path = `backend/${owner.name}/wrangler.jsonc`;
    const worker = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(worker.account_id, account);
    worker.env.dev.hyperdrive[0].id = resource.id;
    await writeFile(path, JSON.stringify(worker, null, 2) + '\n');
  }
  await verifyResources(api);
  console.log(JSON.stringify({ environment: 'dev', account, database: config.database, hyperdrive: 3, tls: 'verify-full', cache: 'disabled' }));
}
async function deploy(api) {
  await verifyResources(api);
  await mkdir('infra/.local', { recursive: true });
  const path = 'infra/.local/web.dev.secrets.json';
  try { await readFile(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(path, JSON.stringify({ DEV_INFRA_TOKEN: randomBytes(32).toString('hex') }), { mode: 0o600 }); }
  // Targets must exist before a consumer binds to them.
  for (const name of ['identity-consent-ecosystem', 'policy-claims-payments', 'acquisition-risk']) {
    wrangler(['deploy', '--config', `backend/${name}/wrangler.jsonc`, '--env', 'dev']);
  }
  wrangler(['deploy', '--config', 'apps/web/wrangler.jsonc', '--env', 'dev', '--secrets-file', path]);
  const subdomain = await api('/workers/subdomain');
  const url = `https://solventa-web-dev.${subdomain.subdomain}.workers.dev`;
  await writeFile('infra/.local/dev-endpoint.json', JSON.stringify({ url, account }));
  // A newly created workers.dev route can take a few seconds to propagate.
  let reachable = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { reachable = (await fetch(url + '/health', { signal: AbortSignal.timeout(5000) })).status === 200; } catch {}
    if (reachable) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(reachable, 'Development route startup timeout');
  await smoke(api);
}
async function smoke(api) {
  await verifyResources(api);
  const { url } = JSON.parse(await readFile('infra/.local/dev-endpoint.json', 'utf8'));
  const { DEV_INFRA_TOKEN: token } = JSON.parse(await readFile('infra/.local/web.dev.secrets.json', 'utf8'));
  const request = (path, authenticated = false) => fetch(url + path, { headers: authenticated ? { authorization: `Bearer ${token}` } : undefined, signal: AbortSignal.timeout(20000) });
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/internal/infra')).status, 401);
  assert.equal((await fetch(url + '/internal/infra', { headers: { authorization: 'Bearer invalid' }, signal: AbortSignal.timeout(20000) })).status, 401);
  const response = await request('/internal/infra', true);
  const result = await response.json();
  console.log(JSON.stringify({ probeStatus: response.status, result }));
  assert.equal(response.status, 200);
  assert.equal(result.ready, true);
  assert.equal(result.services.length, 3);
  for (const service of result.services) assert.equal(service.database, true);
  assert.equal((await request('/api/v1/quotes')).status, 404);
  assert.equal((await request('/')).status, 200);
  for (const owner of owners) {
    const config = JSON.parse(await readFile(`backend/${owner.name}/wrangler.jsonc`, 'utf8'));
    const exposure = await api(`/workers/scripts/${config.env.dev.name}/subdomain`);
    assert.equal(exposure.enabled, false);
    assert.equal(exposure.previews_enabled, false);
  }
  console.log(JSON.stringify({ status: 'passed', environment: 'dev', url, privateBackends: 3, services: result.services }));
}
try {
  const api = await cloudflare();
  const action = process.argv[2];
  if (action === 'up') await up(api);
  else if (action === 'deploy') await deploy(api);
  else if (action === 'verify') await smoke(api);
  else throw Error('Unknown action');
} catch (error) {
  // Assertions may include origins; only emit the safe code, never credentials.
  const cloudflareCode = error.message?.match(/^Cloudflare failed \(([\d,]+)\)$/)?.[1];
  console.error(JSON.stringify({ status: 'failed', code: error.code ?? cloudflareCode ?? 'development_infrastructure_failed' }));
  process.exitCode = 1;
}
