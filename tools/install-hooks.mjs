import { spawnSync } from 'node:child_process';
if (!process.env.CI) {
  const result = spawnSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exitCode = 1;
}
