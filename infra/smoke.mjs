import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { owners } from './database.mjs';
import { localToken } from './secrets.mjs';

const token = await localToken();
const configs = ['apps/web/wrangler.jsonc', ...owners.map(o => `backend/${o.name}/wrangler.local.json`)];
const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js','dev','--local','--port','8790',...configs.flatMap(c => ['-c',c])], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
function diagnostics(chunk) {
  for (const line of chunk.toString().split('\n')) if (line.includes('database_probe_failed') || line.includes('probe_result')) console.log(line);
}
child.stdout.on('data', diagnostics); child.stderr.on('data', diagnostics);
let exited = false;
child.on('exit', () => { exited = true; });
const base = 'http://127.0.0.1:8790';
try {
  let ready = false;
  for (let attempt=0;attempt<60;attempt++) {
    if (exited) throw Error('Worker exited');
    try { ready = (await fetch(base+'/health')).ok; } catch {}
    if (ready) break;
    await new Promise(r => setTimeout(r,1000));
  }
  assert.ok(ready, 'Worker startup timeout');
  assert.equal((await fetch(base+'/internal/infra')).status,401);
  assert.equal((await fetch(base+'/internal/infra',{headers:{authorization:'Bearer invalid'}})).status,401);
  const response = await fetch(base+'/internal/infra',{headers:{authorization:`Bearer ${token}`}});
  const result = await response.json();
  console.log(JSON.stringify({ probeStatus: response.status, result }));
  assert.equal(response.status,200); assert.equal(result.ready,true); assert.equal(result.services.length,3);
  for (const status of result.services) assert.equal(status.database,true);
  assert.equal((await fetch(base+'/api/v1/quotes')).status,404);
  assert.equal((await fetch(base+'/')).status,200);
  console.log(JSON.stringify({ status:'passed', checks:['SQL through Workers','RPC service bindings','invalid-token rejection','static web','business API not enabled'], services:result.services }));
} finally {
  child.kill('SIGINT');
  await new Promise(resolve => { if(exited) resolve(); else { child.once('exit',resolve); setTimeout(() => { child.kill('SIGTERM'); resolve(); },3000).unref(); } });
}
