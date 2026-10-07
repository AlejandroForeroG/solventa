import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, X509Certificate, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { owners, settings, provision, verifyIsolation, verifyEnvironmentIsolation } from './database.mjs';
import { account, remoteEnvironments, configurations, validateEnvironments } from './environments.mjs';

// Every action requires an explicit target. There is no default remote environment.
const environment = process.argv[3];
const profile = process.env.CLOUDFLARE_PROFILE ?? 'solventa-universidad';
function caFingerprint(pem) {
  const certificates = [...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)];
  if (!certificates.length) throw Error('CA bundle is empty');
  return certificates.map(match => new X509Certificate(match[0]).fingerprint256).sort().join(',');
}
function wrangler(args, capture = false) {
  const authentication = process.env.CLOUDFLARE_API_TOKEN ? [] : ['--profile', profile];
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args, ...authentication], { windowsHide: true, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.status !== 0) throw Error('Wrangler failed');
  return result.stdout;
}
async function cloudflare() {
  if (process.env.CI && !process.env.CLOUDFLARE_API_TOKEN) throw Object.assign(Error('CI requires its deployment token'), { code: 'missing_CLOUDFLARE_API_TOKEN' });
  const token = process.env.CLOUDFLARE_API_TOKEN ?? JSON.parse(wrangler(['auth', 'token', '--json'], true)).token;
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
  const config = await settings(environment);
  validateEnvironments(await configurations(), environment);
  if (!config.ssl.ca) throw Error('Remote TLS verification requires DATABASE_CA_FILE');
  const expectedCA = caFingerprint(config.ssl.ca);
  const verifiedCAs = new Set();
  for (const owner of owners) {
    const worker = JSON.parse(await readFile(`backend/${owner.name}/wrangler.jsonc`, 'utf8'));
    assert.equal(worker.account_id, account);
    const resource = await api(`/hyperdrive/configs/${worker.env[environment].hyperdrive[0].id}`);
    assert.equal(resource.name, `solventa-${owner.schema}-${environment}`);
    assert.equal(resource.origin.host, config.url.hostname);
    assert.equal(resource.origin.database, config.database);
    assert.equal(resource.origin.user, `solventa_${environment}_${owner.schema}`);
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
  validateEnvironments(await configurations());
  const config = await settings(environment);
  if (!config.ssl.ca) throw Error('Remote TLS verification requires DATABASE_CA_FILE');
  await provision(environment);
  await verifyIsolation(environment);
  const state = JSON.parse(await readFile(`infra/.local/runtime.${environment}.json`, 'utf8'));
  const fingerprint = caFingerprint(config.ssl.ca);
  const certificateName = `solventa-ca-${createHash('sha256').update(fingerprint).digest('hex').slice(0, 32)}`;
  const certificates = await api('/mtls_certificates');
  let certificate = certificates.find(item => item.ca === true && caFingerprint(item.certificates) === fingerprint);
  if (!certificate) certificate = await api('/mtls_certificates', 'POST', { name: certificateName, certificates: config.ssl.ca, ca: true });
  const existing = await api('/hyperdrive/configs');
  for (const owner of owners) {
    const name = `solventa-${owner.schema}-${environment}`;
    let resource = existing.find(item => item.name === name);
    const body = {
      name,
      origin: { scheme: 'postgres', host: config.url.hostname, port: Number(config.url.port || 26257), database: config.database, user: `solventa_${environment}_${owner.schema}`, password: state.passwords[owner.schema] },
      mtls: { sslmode: 'verify-full', ca_certificate_id: certificate.id }, caching: { disabled: true }, origin_connection_limit: 5,
    };
    if (resource) {
      if (resource.origin?.database !== config.database || resource.origin?.user !== body.origin.user || resource.origin?.host !== body.origin.host) throw Error('Existing resource belongs to another origin');
      resource = await api(`/hyperdrive/configs/${resource.id}`, 'PUT', body);
    } else resource = await api('/hyperdrive/configs', 'POST', body);
    const path = `backend/${owner.name}/wrangler.jsonc`;
    const worker = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(worker.account_id, account);
    worker.env[environment].hyperdrive[0].id = resource.id;
    await writeFile(path, JSON.stringify(worker, null, 2) + '\n');
  }
  await verifyResources(api);
  console.log(JSON.stringify({ environment, account, database: config.database, hyperdrive: 3, tls: 'verify-full', cache: 'disabled' }));
}
async function deploy(api) {
  await verifyResources(api);
  await mkdir('infra/.local', { recursive: true });
  const path = `infra/.local/web.${environment}.secrets.json`;
  try { await readFile(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const scripts = await api('/workers/scripts');
    if (scripts.some(script => script.id === `solventa-web-${environment}`)) {
      const secrets = await api(`/workers/scripts/solventa-web-${environment}/secrets`);
      if (secrets.some(secret => secret.name === 'DEV_INFRA_TOKEN')) throw Object.assign(Error('Restore the existing diagnostic secret'), { code: 'web_state_missing' });
    }
    await writeFile(path, JSON.stringify({ DEV_INFRA_TOKEN: randomBytes(32).toString('hex') }), { mode: 0o600 });
  }
  const { DEV_INFRA_TOKEN: token } = JSON.parse(await readFile(path, 'utf8'));
  assert.match(token, /^[a-f0-9]{64}$/);
  for (const other of remoteEnvironments.filter(e => e !== environment)) {
    try {
      const secrets = JSON.parse(await readFile(`infra/.local/web.${other}.secrets.json`, 'utf8'));
      assert.notEqual(token, secrets.DEV_INFRA_TOKEN, 'Diagnostic secrets cannot be shared across environments');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // Targets must exist before a consumer binds to them.
  for (const name of ['identity-consent-ecosystem', 'policy-claims-payments', 'acquisition-risk']) {
    const authSecrets = name === 'identity-consent-ecosystem' ? ['--secrets-file', `infra/.local/identity.${environment}.secrets.json`] : [];
    wrangler(['deploy', '--config', `backend/${name}/wrangler.jsonc`, '--env', environment, ...authSecrets]);
  }
  wrangler(['deploy', '--config', 'apps/web/wrangler.jsonc', '--env', environment, '--secrets-file', path]);
  const subdomain = await api('/workers/subdomain');
  const url = `https://solventa-web-${environment}.${subdomain.subdomain}.workers.dev`;
  await writeFile(`infra/.local/${environment}-endpoint.json`, JSON.stringify({ url, account, environment }));
  // A newly created workers.dev route can take a few seconds to propagate.
  let reachable = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { reachable = (await fetch(url + '/health', { signal: AbortSignal.timeout(5000) })).status === 200; } catch {}
    if (reachable) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(reachable, 'Remote route startup timeout');
  await smoke(api);
}
async function smoke(api) {
  await verifyResources(api);
  const { url } = JSON.parse(await readFile(`infra/.local/${environment}-endpoint.json`, 'utf8'));
  const { DEV_INFRA_TOKEN: token } = JSON.parse(await readFile(`infra/.local/web.${environment}.secrets.json`, 'utf8'));
  assert.match(token, /^[a-f0-9]{64}$/);
  const request = (path, authenticated = false) => fetch(url + path, { headers: authenticated ? { authorization: `Bearer ${token}` } : undefined, signal: AbortSignal.timeout(20000) });
  assert.equal((await request('/health')).status, 200);
  let sessionResponse;
  let login;
  for (let attempt = 0; attempt < 20; attempt++) {
    sessionResponse = await request('/auth/session');
    login = await fetch(url + '/auth/login', { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    if (sessionResponse.status === 401 && login.status === 302) break;
    if (attempt < 19) await new Promise(resolve => setTimeout(resolve, 1500));
  }
  assert.equal(sessionResponse.status, 401, 'Authentication configuration must be ready');
  assert.equal(login.status, 302);
  const authorization = new URL(login.headers.get('location'));
  assert.equal(authorization.origin, 'https://api.workos.com');
  assert.equal(authorization.searchParams.get('redirect_uri'), url + '/auth/callback');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal((await request('/internal/infra')).status, 401);
  assert.equal((await fetch(url + '/internal/infra', { headers: { authorization: 'Bearer invalid' }, signal: AbortSignal.timeout(20000) })).status, 401);
  // Deployment routing can briefly serve the previous version of web or a backend.
  // Wait for all environment-aware probes, without retrying any business operation.
  let response;
  let result;
  for (let attempt = 0; attempt < 20; attempt++) {
    response = await request('/internal/infra', true);
    result = await response.json();
    if (response.status === 200 && result.environment === environment && result.ready === true &&
        result.services?.length === 3 && result.services.every(s => s.environment === environment && s.databaseName === `solventa_${environment}`)) break;
    if (attempt < 19) await new Promise(resolve => setTimeout(resolve, 1500));
  }
  console.log(JSON.stringify({ probeStatus: response.status, result }));
  assert.equal(response.status, 200);
  assert.equal(result.ready, true);
  assert.equal(result.environment, environment);
  assert.equal(result.services.length, 3);
  for (const service of result.services) {
    assert.equal(service.database, true);
    assert.equal(service.environment, environment);
    assert.equal(service.databaseName, `solventa_${environment}`);
  }
  assert.equal((await request('/api/v1/quotes')).status, 404);
  assert.equal((await request('/')).status, 200);
  for (const owner of owners) {
    const config = JSON.parse(await readFile(`backend/${owner.name}/wrangler.jsonc`, 'utf8'));
    const exposure = await api(`/workers/scripts/${config.env[environment].name}/subdomain`);
    assert.equal(exposure.enabled, false);
    assert.equal(exposure.previews_enabled, false);
  }
  console.log(JSON.stringify({ status: 'passed', environment, url, authentication: 'configured', privateBackends: 3, services: result.services }));
}
try {
  if (!remoteEnvironments.includes(environment)) throw Error('Specify dev, staging or prod');
  const api = await cloudflare();
  const action = process.argv[2];
  if (action === 'up') await up(api);
  else if (action === 'deploy') await deploy(api);
  else if (action === 'verify') {
    await verifyIsolation(environment);
    await verifyEnvironmentIsolation(environment);
    await smoke(api);
  }
  else throw Error('Unknown action');
} catch (error) {
  // Assertions may include origins; only emit the safe code, never credentials.
  const cloudflareCode = error.message?.match(/^Cloudflare failed \(([\d,]+)\)$/)?.[1];
  console.error(JSON.stringify({ status: 'failed', environment, code: error.code ?? cloudflareCode ?? 'remote_infrastructure_failed' }));
  process.exitCode = 1;
}
