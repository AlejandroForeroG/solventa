import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, access, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./ci.mjs', import.meta.url));

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
