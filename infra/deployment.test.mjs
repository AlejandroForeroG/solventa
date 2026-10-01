import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the deployment guard rejects an unmerged commit even when the target is dev', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'solventa-deploy-'));
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  const workflow = await readFile('.github/workflows/deploy.yml', 'utf8');
  const block = workflow.match(/name: Require integrated code for every environment\r?\n\s+run: \|\r?\n((?: {10}[^\r\n]+\r?\n)+)/)?.[1];
  assert.ok(block, 'Missing integration guard');
  const guard = block.split(/\r?\n/).filter(Boolean).map(line => line.slice(10)).join('\n');
  const git = args => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const check = environment => spawnSync(bash, ['-c', guard], { cwd: directory, env: { ...process.env, TARGET_ENVIRONMENT: environment }, encoding: 'utf8', windowsHide: true });
  try {
    git(['init', '-b', 'main']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'integrated']);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    for (const environment of ['dev', 'staging', 'prod']) assert.equal(check(environment).status, 0);
    git(['checkout', '-b', 'unmerged']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'unreviewed']);
    for (const environment of ['dev', 'staging', 'prod']) assert.notEqual(check(environment).status, 0);
  } finally { await rm(directory, { recursive: true }); }
});
