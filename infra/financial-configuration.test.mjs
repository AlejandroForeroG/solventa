import { test } from 'node:test';
import assert from 'node:assert/strict';
import { financialSecrets } from './financial-configuration.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, access, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { rootCertificates } from 'node:tls';

test('financial credentials are optional, environment-bound and unavailable for production mocks', () => {
  const key = 'a'.repeat(64);
  const configuration = (environment, secrets = { FINANCIAL_EVENT_KEY: key }) => JSON.stringify({ environment, secrets });
  for (const environment of ['dev', 'staging', 'prod']) assert.deepEqual(financialSecrets(environment, ''), { FINANCIAL_EVENT_KEY: '' });
  for (const environment of ['dev', 'staging']) assert.deepEqual(financialSecrets(environment, configuration(environment)), { FINANCIAL_EVENT_KEY: key });
  assert.throws(() => financialSecrets('prod', configuration('prod')));
  assert.throws(() => financialSecrets('staging', configuration('dev')));
  assert.throws(() => financialSecrets('dev', configuration('dev', { FINANCIAL_EVENT_KEY: 'short' })));
  assert.throws(() => financialSecrets('dev', configuration('dev', { FINANCIAL_EVENT_KEY: key, unrelated: key })));
  assert.throws(() => financialSecrets('dev', JSON.stringify({ environment: 'dev', secrets: { FINANCIAL_EVENT_KEY: key }, recipient: 'unrequested' })));
});

test('CI restores financial keys without printing them and cleans only its selected environment', async () => {
  const script = fileURLToPath(new URL('./ci.mjs', import.meta.url));
  const key = 'b'.repeat(64);
  for (const [environment, configuredEnvironment, accepted] of [['dev', 'dev', true], ['staging', 'dev', false], ['prod', 'prod', false]]) {
    const directory = await mkdtemp(join(tmpdir(), 'solventa-financial-config-'));
    try {
      const runtime = 'a'.repeat(64);
      const env = { ...process.env, DATABASE_HOST: 'database.example.com', DATABASE_CA_PEM: rootCertificates[0],
        RUNTIME_STATE_JSON: JSON.stringify({ database: `solventa_${environment}`, passwords: { acquisition: runtime, identity: runtime, policy: runtime } }),
        WEB_INFRA_TOKEN: runtime, IDENTITY_AUTH_JSON: JSON.stringify({ environment, secrets: { WORKOS_CLIENT_ID: 'client_synthetic', WORKOS_API_KEY: 'sk_' + 'c'.repeat(75), AUTH_COOKIE_PASSWORD: runtime } }),
        SECURITY_ALERT_EMAIL_CONFIG: '', FINANCIAL_EVENT_JSON: JSON.stringify({environment: configuredEnvironment, secrets: {FINANCIAL_EVENT_KEY:key}}) };
      const result = spawnSync(process.execPath, [script, 'prepare', environment], {cwd:directory, env, encoding:'utf8', windowsHide:true});
      assert.equal(result.status === 0, accepted);
      assert.ok(!result.stdout.includes(key) && !result.stderr.includes(key));
      const path = join(directory, `infra/.local/financial.${environment}.secrets.json`);
      if (!accepted) await assert.rejects(access(join(directory, 'infra/.local')), {code:'ENOENT'});
      else {
        assert.deepEqual(JSON.parse(await readFile(path,'utf8')), {FINANCIAL_EVENT_KEY:key});
        assert.equal(spawnSync(process.execPath, [script, 'cleanup', 'staging'], {cwd:directory, windowsHide:true}).status,0);
        await access(path);
        assert.equal(spawnSync(process.execPath, [script, 'cleanup', environment], {cwd:directory, windowsHide:true}).status,0);
        await assert.rejects(access(path), {code:'ENOENT'});
      }
    } finally { await rm(directory,{recursive:true}); }
  }
});
