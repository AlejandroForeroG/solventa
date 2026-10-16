import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { owners } from './database.mjs';
import { localToken } from './secrets.mjs';
import { randomUUID } from 'node:crypto';

const token = await localToken();
const configs = ['apps/web/wrangler.jsonc', ...owners.map(o => `backend/${o.name}/wrangler.local.json`)];
const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js','dev','--local','--port','8790',...configs.flatMap(c => ['-c',c])], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
function diagnostics(chunk) {
  for (const line of chunk.toString().split('\n')) if (line.includes('database_probe_failed') || line.includes('probe_result') || line.includes('security_denial_persistence_failed')) console.log(line);
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
  assert.equal(result.environment, 'local');
  for (const status of result.services) {
    assert.equal(status.database,true);
    assert.equal(status.environment, 'local');
    assert.equal(status.databaseName, 'solventa_local');
  }
  assert.equal((await fetch(base+'/api/v1/quotes')).status,404);
  const json={'content-type':'application/json'};
  async function credentialAttempt(path, method, headers = {}) {
    const traceId = randomUUID();
    const response = await fetch(base+path,{method,headers:{...headers,'x-trace-id':traceId},...(method==='POST'?{body:'{}'}:{})});
    const body = await response.json();
    const error = ['unauthorized','forbidden','access_unavailable','service_unavailable','invalid_request'].includes(body?.error) ? body.error : 'unknown_response';
    console.log(JSON.stringify({event:'credential_smoke',path,status:response.status,error,traceId:body?.traceId===traceId?traceId:undefined}));
    return {status:response.status,error};
  }
  assert.equal((await credentialAttempt('/api/v1/access/partner','GET')).status,401);
  // An invalid partner token is 401 once partner verification is configured and 503 while it is not.
  assert.ok([401,503].includes((await credentialAttempt('/api/v1/quotes','POST',{...json,authorization:'Bearer invalid.partner.token'})).status));
  assert.equal((await credentialAttempt('/api/v1/quotes','POST',json)).status,401);
  assert.equal((await credentialAttempt('/api/v1/me/quotes','POST',json)).status,401);
  assert.equal((await credentialAttempt('/api/v1/me/quotes','POST',{...json,authorization:'Bearer x'})).status,400);
  assert.equal((await fetch(base+'/')).status,200);
  console.log(JSON.stringify({ status:'passed', checks:['SQL through Workers','RPC service bindings','invalid-token rejection','static web','quote API rejects missing and invalid credentials on both entries'], services:result.services }));
} finally {
  child.kill('SIGINT');
  await new Promise(resolve => { if(exited) resolve(); else { child.once('exit',resolve); setTimeout(() => { child.kill('SIGTERM'); resolve(); },3000).unref(); } });
}
