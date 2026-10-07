import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { remoteEnvironments } from './environments.mjs';

// CI only restores runtime credentials. Administrative SQL never enters the runner.
const [action, environment] = process.argv.slice(2);
try {
  assert.ok(remoteEnvironments.includes(environment));
  const caPath = `infra/.local/ci-ca.${environment}.pem`;
  const paths = [caPath, `.env.infra.${environment}`, `infra/.local/runtime.${environment}.json`, `infra/.local/web.${environment}.secrets.json`, `infra/.local/identity.${environment}.secrets.json`, `infra/.local/${environment}-endpoint.json`];
  if (action === 'prepare') {
    const { DATABASE_HOST: host, DATABASE_PORT: port = '26257', DATABASE_CA_PEM: ca, RUNTIME_STATE_JSON: runtime, WEB_INFRA_TOKEN: token } = process.env;
    for (const [name, value] of Object.entries({ DATABASE_HOST: host, DATABASE_CA_PEM: ca, RUNTIME_STATE_JSON: runtime, WEB_INFRA_TOKEN: token })) {
      if (!value) throw Object.assign(Error('Missing CI configuration'), { code: `missing_${name}` });
    }
    assert.match(host, /^[a-zA-Z0-9.-]+$/);
    assert.ok(!['localhost', '127.0.0.1'].includes(host));
    assert.match(port || '26257', /^\d{1,5}$/);
    const state = JSON.parse(runtime);
    assert.equal(state.database, `solventa_${environment}`);
    for (const schema of ['acquisition', 'identity', 'policy']) assert.match(state.passwords[schema], /^[a-f0-9]{64}$/);
    assert.match(token, /^[a-f0-9]{64}$/);
    const certificates = [...ca.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)];
    assert.ok(certificates.length > 0);
    for (const certificate of certificates) assert.equal(new X509Certificate(certificate[0]).ca, true);
    const auth = JSON.parse(process.env.IDENTITY_AUTH_JSON || 'null');
    assert.equal(auth?.environment, environment);
    assert.match(auth.secrets.WORKOS_CLIENT_ID, /^client_[a-zA-Z0-9]+$/);
    // WorkOS environment keys use sk_; their prefix does not prove their scope.
    // Retain rejection of explicitly test/live-labelled credentials in the wrong target.
    assert.match(auth.secrets.WORKOS_API_KEY, environment === 'prod' ? /^sk_(?:live_)?[a-zA-Z0-9]+$/ : /^sk_(?:test_)?[a-zA-Z0-9]+$/);
    assert.match(auth.secrets.AUTH_COOKIE_PASSWORD, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(auth.secrets).sort(), ['AUTH_COOKIE_PASSWORD','WORKOS_API_KEY','WORKOS_CLIENT_ID']);
    await mkdir('infra/.local', { recursive: true, mode: 0o700 });
    await writeFile(caPath, ca, { mode: 0o600 });
    // Deliberately no username, password or client key in this origin descriptor.
    await writeFile(`.env.infra.${environment}`, `DATABASE_URL=postgresql://${host}:${port || '26257'}/defaultdb\nDATABASE_CA_FILE=${caPath}\n`, { mode: 0o600 });
    await writeFile(`infra/.local/runtime.${environment}.json`, JSON.stringify(state), { mode: 0o600 });
    await writeFile(`infra/.local/web.${environment}.secrets.json`, JSON.stringify({ DEV_INFRA_TOKEN: token }), { mode: 0o600 });
    await writeFile(`infra/.local/identity.${environment}.secrets.json`, JSON.stringify(auth.secrets), { mode: 0o600 });
    console.log(JSON.stringify({ environment, credentials: 'restored' }));
  } else if (action === 'cleanup') {
    for (const path of paths) await rm(path, { force: true });
  } else throw Error('Unknown CI operation');
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: error.code ?? 'invalid_ci_configuration' }));
  process.exitCode = 1;
}
