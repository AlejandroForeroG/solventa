import { spawnSync, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { owners, provision, verifyIsolation } from './database.mjs';
import { resolve } from 'node:path';
import { localToken } from './secrets.mjs';

const compose = ['compose', '-f', 'infra/compose.yml'];
// Certificates must remain readable by the invoking user on Linux as well as Windows.
process.env.LOCAL_UID = String(process.getuid?.() ?? 1000);
process.env.LOCAL_GID = String(process.getgid?.() ?? 1000);
function docker(args) { const r = spawnSync('docker', [...compose, ...args], { stdio: 'inherit', windowsHide: true }); if (r.status !== 0) throw Error('Docker command failed'); }
const action = process.argv[2];
try {
  if (action === 'up') {
    await mkdir('infra/.local/certs', { recursive: true });
    try { await access('.env.infra.local'); } catch { await writeFile('.env.infra.local', await readFile('.env.infra.example'), { mode: 0o600 }); }
    docker(['up', '-d', '--wait', '--wait-timeout', '120']);
    await provision('local');
    await verifyIsolation('local');
    await localToken();
    const state = JSON.parse(await readFile('infra/.local/runtime.local.json', 'utf8'));
    for (const owner of owners) {
      const config = JSON.parse(await readFile(`backend/${owner.name}/wrangler.jsonc`, 'utf8'));
      const url = new URL('postgresql://localhost:26258/solventa_local');
      url.username = `solventa_local_${owner.schema}`; url.password = state.passwords[owner.schema];
      url.searchParams.set('sslmode', 'verify-full');
      url.searchParams.set('sslrootcert', resolve('infra/.local/certs/ca.crt'));
      config.hyperdrive[0].localConnectionString = url.toString();
      await writeFile(`backend/${owner.name}/wrangler.local.json`, JSON.stringify(config));
    }
  } else if (action === 'down') docker(['down']);
  else if (action === 'dev') {
    const args = ['node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '-c', 'apps/web/wrangler.jsonc', ...owners.flatMap(o => ['-c', `backend/${o.name}/wrangler.local.json`])];
    for (const owner of owners) await access(`backend/${owner.name}/wrangler.local.json`);
    const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  } else throw Error('Unknown action');
} catch { console.error('Local infrastructure failed; inspect Docker status and local configuration.'); process.exitCode = 1; }
