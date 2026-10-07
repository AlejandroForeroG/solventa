import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, access, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { rootCertificates } from 'node:tls';

const script = fileURLToPath(new URL('./ci.mjs', import.meta.url));

test('WorkOS environment credentials accept documented keys and reject mismatches before writing', async () => {
  for (const [environment, taggedEnvironment, apiKey, accepted] of [
    ['prod', 'prod', 'sk_' + 'b'.repeat(75), true],
    ['staging', 'staging', 'sk_' + 'c'.repeat(75), true],
    ['prod', 'dev', 'sk_' + 'b'.repeat(75), false],
    ['prod', 'prod', 'sk_test_' + 'b'.repeat(32), false],
    ['dev', 'dev', 'sk_live_' + 'b'.repeat(32), false],
    ['prod', 'prod', 'pk_' + 'b'.repeat(32), false],
  ]) {
    const directory = await mkdtemp(join(tmpdir(), 'solventa-ci-'));
    try {
      const secret = 'a'.repeat(64);
      const auth = { environment: taggedEnvironment, secrets: { WORKOS_CLIENT_ID: 'client_synthetic', WORKOS_API_KEY: apiKey, AUTH_COOKIE_PASSWORD: secret } };
      const env = { ...process.env, DATABASE_HOST: 'database.example.com', DATABASE_CA_PEM: rootCertificates[0], RUNTIME_STATE_JSON: JSON.stringify({ database: `solventa_${environment}`, passwords: { acquisition: secret, identity: secret, policy: secret } }), WEB_INFRA_TOKEN: secret, IDENTITY_AUTH_JSON: JSON.stringify(auth) };
      const result = spawnSync(process.execPath, [script, 'prepare', environment], { cwd: directory, env, encoding: 'utf8', windowsHide: true });
      assert.equal(result.status === 0, accepted, `${environment}/${taggedEnvironment}`);
      assert.ok(!result.stdout.includes(apiKey) && !result.stderr.includes(apiKey));
      if (accepted) assert.deepEqual(JSON.parse(await readFile(join(directory, `infra/.local/identity.${environment}.secrets.json`), 'utf8')), auth.secrets);
      else await assert.rejects(access(join(directory, 'infra/.local')), { code: 'ENOENT' });
    } finally { await rm(directory, { recursive: true }); }
  }
});

test('restoring development credentials into production fails before writing files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'solventa-ci-'));
  try {
    const secret = 'a'.repeat(64);
    const env = { ...process.env, DATABASE_HOST: 'database.example.com', DATABASE_CA_PEM: 'unused', RUNTIME_STATE_JSON: JSON.stringify({ database: 'solventa_dev', passwords: { acquisition: secret, identity: secret, policy: secret } }), WEB_INFRA_TOKEN: secret };
    const result = spawnSync(process.execPath, [script, 'prepare', 'prod'], { cwd: directory, env, encoding: 'utf8', windowsHide: true });
    assert.notEqual(result.status, 0);
    assert.ok(!result.stderr.includes(secret));
    await assert.rejects(access(join(directory, 'infra/.local')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true }); }
});

test('cleanup preserves credentials belonging to another environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'solventa-ci-'));
  try {
    await mkdir(join(directory, 'infra/.local'), { recursive: true });
    const retained = join(directory, 'infra/.local/runtime.dev.json');
    const removed = join(directory, 'infra/.local/runtime.prod.json');
    await writeFile(retained, 'retained');
    await writeFile(removed, 'removed');
    const result = spawnSync(process.execPath, [script, 'cleanup', 'prod'], { cwd: directory, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0);
    assert.equal(await readFile(retained, 'utf8'), 'retained');
    await assert.rejects(access(removed), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true }); }
});
