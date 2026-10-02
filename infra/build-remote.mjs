import { spawnSync } from 'node:child_process';
import { configurations, validateEnvironments, remoteEnvironments } from './environments.mjs';

validateEnvironments(await configurations());
for (const environment of remoteEnvironments) {
  for (const name of ['identity-consent-ecosystem', 'policy-claims-payments', 'acquisition-risk', 'web']) {
    const config = name === 'web' ? 'apps/web/wrangler.jsonc' : `backend/${name}/wrangler.jsonc`;
    const outdir = name === 'web' ? `worker-dist/${environment}` : `dist/${environment}`;
    const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', config, '--env', environment, '--dry-run', '--outdir', outdir], { stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
