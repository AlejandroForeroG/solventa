import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { remoteEnvironments } from './environments.mjs';

export function migrationConfiguration(environment, variables) {
  assert.ok(remoteEnvironments.includes(environment));
  assert.equal(variables.GITHUB_REF_NAME, environment);
  const { DATABASE_HOST: host, DATABASE_PORT: configuredPort, DATABASE_CA_PEM: ca, RUNTIME_STATE_JSON: runtime, MIGRATION_DATABASE_URL: value } = variables;
  const port = configuredPort || '26257';
  for (const [name, entry] of Object.entries({ DATABASE_HOST: host, DATABASE_CA_PEM: ca, RUNTIME_STATE_JSON: runtime, MIGRATION_DATABASE_URL: value })) {
    if (!entry) throw Object.assign(Error('Missing migration configuration'), { code: `missing_${name}` });
  }
  assert.match(host, /^[a-zA-Z0-9.-]+$/);
  assert.ok(!['localhost', '127.0.0.1'].includes(host));
  assert.match(port, /^\d{1,5}$/);
  const url = new URL(value);
  assert.ok(['postgresql:', 'postgres:'].includes(url.protocol));
  assert.equal(url.hostname, host);
  assert.equal(url.port || '5432', port);
  assert.equal(url.pathname, `/solventa_${environment}`);
  assert.ok(url.username && url.password);
  assert.ok(!url.hash);
  // Trust and client identity come only from this job's explicit environment.
  for (const [key, entry] of url.searchParams) assert.ok(key === 'sslmode' && entry === 'verify-full');
  url.search = '';
  const state = JSON.parse(runtime);
  assert.equal(state.database, `solventa_${environment}`);
  assert.deepEqual(Object.keys(state.passwords).sort(), ['acquisition', 'identity', 'policy']);
  for (const password of Object.values(state.passwords)) assert.match(password, /^[a-f0-9]{64}$/);
  const certificates = [...ca.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)];
  assert.ok(certificates.length);
  for (const certificate of certificates) assert.equal(new X509Certificate(certificate[0]).ca, true);
  return { url, state, ca };
}

export async function migrationCredentials(action, environment, variables = process.env) {
  assert.ok(remoteEnvironments.includes(environment));
  const caPath = `infra/.local/ci-migration-ca.${environment}.pem`;
  const paths = [caPath, `.env.infra.${environment}`, `infra/.local/runtime.${environment}.json`];
  const manifest = `infra/.local/ci-migration-files.${environment}.json`;
  if (action === 'cleanup') {
    try { assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')), paths); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const path of paths) await rm(path, { force: true });
    await rm(manifest);
    return;
  }
  assert.equal(action, 'prepare');
  const { url, state, ca } = migrationConfiguration(environment, variables);
  // Never replace an operator's existing files when invoked outside a clean runner.
  for (const path of paths) {
    try { await readFile(path); throw Object.assign(Error('Credential path exists'), { code: 'migration_credentials_exist' }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir('infra/.local', { recursive: true, mode: 0o700 });
  await writeFile(manifest, JSON.stringify(paths), { mode: 0o600, flag: 'wx' });
  await writeFile(caPath, ca, { mode: 0o600, flag: 'wx' });
  await writeFile(paths[1], `DATABASE_URL=${JSON.stringify(url.toString())}\nDATABASE_CA_FILE=${caPath}\n`, { mode: 0o600, flag: 'wx' });
  await writeFile(paths[2], JSON.stringify(state), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ environment, migrationCredentials: 'restored' }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [action, environment, ...extra] = process.argv.slice(2);
  try {
    assert.equal(extra.length, 0);
    await migrationCredentials(action, environment);
  } catch (error) {
    console.error(JSON.stringify({ environment, status: 'failed', code: error.code ?? 'invalid_migration_configuration' }));
    process.exitCode = 1;
  }
}
