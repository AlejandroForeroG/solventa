import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { lifecycleFixture, lifecycleRecord } from './support/policy-lifecycle-fixture';
import { authorizeAdvisorApproval } from '../backend/identity-consent-ecosystem/src/application/advisor-access';
import { ApiAccess } from '../backend/identity-consent-ecosystem/src/application/api-access';
import { mountAdvisor } from '../backend/policy-claims-payments/src/adapters/inbound/advisor-http';

const start='2026-10-16T02:01:00.000Z';
async function fixture(action:'cancelled'|'modified'|'renewed'='cancelled') {
  const source=await lifecycleRecord(),owner={clientId:source.policy.clientId,subjectToken:source.policy.subjectToken};
  const replacement=await lifecycleRecord(owner,action==='renewed'?source.policy.effectiveUntil:'2026-10-16T02:00:30.000Z');
  const f=lifecycleFixture([source,replacement]),advisor={clientId:randomUUID(),subjectToken:randomUUID(),advisorReference:randomUUID(),authorizationExpiresAt:new Date(Date.parse(start)+5000).toISOString()};
  const input={actor:owner,advisor:{principal:{clientId:advisor.clientId,subjectToken:advisor.subjectToken},reference:advisor.advisorReference,expiresAt:advisor.authorizationExpiresAt},
    policyId:source.policy.id,action,replacementPolicyId:action==='cancelled'?null:replacement.policy.id,documentHash:source.policy.documentHash,
    expiresAt:new Date(Date.parse(start)+86400000).toISOString(),idempotencyKey:randomUUID(),traceId:randomUUID()};
  return{...f,source,replacement,owner,advisor,input};
}
test('a customer approves one action; only its advisor executes without access to payments or signed bytes',async()=>{
  const f=await fixture('modified'),approval=await f.finance.createAdvisorAuthorization(f.input);assert.equal(approval.status,'ok');if(approval.status!=='ok')return;
  const command={actor:f.advisor,authorizationId:approval.authorization.authorizationId,reason:'coverage_change',idempotencyKey:randomUUID(),traceId:randomUUID()};
  assert.equal((await f.finance.changeAdvisorLifecycle({...command,actor:{...f.advisor,clientId:randomUUID()}})).status,'denied');
  const first=await f.finance.changeAdvisorLifecycle(command);assert.equal(first.status,'ok');if(first.status!=='ok')return;
  assert.equal('policy' in first,false);assert.equal('payment' in first,false);assert.equal(first.action,'modified');
  const replay=await f.finance.changeAdvisorLifecycle(command);assert.equal(replay.status,'ok');if(replay.status==='ok')assert.equal(replay.replayed,true);
  assert.equal(f.record(f.source.policy.id)?.policy.lifecycle?.replacementDocumentHash,f.replacement.policy.documentHash);
  assert.equal(f.approval(approval.authorization.authorizationId)?.changeId,first.changeId);
  assert.equal(f.captures.length,2);
  assert.equal((await f.finance.changeAdvisorLifecycle({...command,reason:'another_reason'})).status,'denied');
});
test('owner revocation blocks execution and protected replay; a different owner cannot grant or revoke',async()=>{
  const f=await fixture(),approval=await f.finance.createAdvisorAuthorization(f.input);assert.equal(approval.status,'ok');if(approval.status!=='ok')return;
  const id=approval.authorization.authorizationId,command={actor:f.advisor,authorizationId:id,reason:'customer_request',idempotencyKey:randomUUID(),traceId:randomUUID()};
  assert.equal((await f.finance.revokeAdvisorAuthorization({actor:{...f.owner,subjectToken:randomUUID()},policyId:f.input.policyId,authorizationId:id,traceId:randomUUID()})).status,'denied');
  assert.equal((await f.finance.revokeAdvisorAuthorization({actor:f.owner,policyId:f.input.policyId,authorizationId:id,traceId:randomUUID()})).status,'ok');
  assert.equal((await f.finance.changeAdvisorLifecycle(command)).status,'denied');assert.equal(f.record(f.input.policyId)?.policy.lifecycle,undefined);
  assert.equal((await f.finance.createAdvisorAuthorization({...f.input,actor:{...f.owner,clientId:randomUUID()},idempotencyKey:randomUUID()})).status,'denied');
});
test('approval expiry during write and replay rolls back or withholds the result',async()=>{
  for(const stage of ['write','command'] as const) {
    const f=await fixture(),approval=await f.finance.createAdvisorAuthorization({...f.input,expiresAt:new Date(Date.parse(start)+1000).toISOString()});assert.equal(approval.status,'ok');if(approval.status!=='ok')continue;
    const command={actor:f.advisor,authorizationId:approval.authorization.authorizationId,reason:'customer_request',idempotencyKey:randomUUID(),traceId:randomUUID()};
    if(stage==='command')assert.equal((await f.finance.changeAdvisorLifecycle(command)).status,'ok');
    const before=f.captures.length;f.during(stage,()=>f.setNow(new Date(Date.parse(start)+1500).toISOString()));
    assert.equal((await f.finance.changeAdvisorLifecycle(command)).status,'unavailable');assert.equal(f.captures.length,before);
    if(stage==='write')assert.equal(f.record(f.input.policyId)?.policy.lifecycle,undefined);
  }
});
test('changed advisor reference, expired lease, tampered approval and failed persistence fail closed',async()=>{
  for(const mode of ['reference','lease','tampered','audit'] as const) {
    const f=await fixture(),approval=await f.finance.createAdvisorAuthorization(f.input);if(approval.status!=='ok')throw Error('fixture');
    if(mode==='tampered'){const saved=f.approval(approval.authorization.authorizationId);if(saved)saved.authorization.action='renewed';}
    if(mode==='audit')f.fail();
    const actor=mode==='reference'?{...f.advisor,advisorReference:randomUUID()}:mode==='lease'?{...f.advisor,authorizationExpiresAt:start}:f.advisor;
    const result=await f.finance.changeAdvisorLifecycle({actor,authorizationId:approval.authorization.authorizationId,reason:'customer_request',idempotencyKey:randomUUID(),traceId:randomUUID()});
    assert.notEqual(result.status,'ok');assert.equal(f.record(f.input.policyId)?.policy.lifecycle,undefined);
  }
});
test('professional reference filters approvals before the result limit and owner retains history',async()=>{
  const f=await fixture();
  for(let i=0;i<22;i++)assert.equal((await f.finance.createAdvisorAuthorization({...f.input,idempotencyKey:randomUUID()})).status,'ok');
  const current={...f.advisor,advisorReference:randomUUID()};
  assert.equal((await f.finance.createAdvisorAuthorization({...f.input,advisor:{...f.input.advisor,reference:current.advisorReference},idempotencyKey:randomUUID()})).status,'ok');
  const list=await f.finance.advisorAuthorizations({actor:current,traceId:randomUUID()});assert.equal(list.status,'ok');if(list.status==='ok'){assert.equal(list.authorizations.length,1);assert.equal(list.hasMore,false);}
  const own=await f.finance.listAdvisorAuthorizations({actor:f.owner,policyId:f.input.policyId,traceId:randomUUID()});
  if(own.status!=='ok'||!own.nextCursor)throw Error('owner list');
  assert.equal(own.authorizations.length,20);assert.equal(own.hasMore,true);
  const next=await f.finance.listAdvisorAuthorizations({actor:f.owner,policyId:f.input.policyId,traceId:randomUUID(),after:own.nextCursor});
  if(next.status!=='ok')throw Error('next page');assert.equal(next.authorizations.length,3);
  assert.equal(next.authorizations.some(a=>own.authorizations.some(b=>a.authorizationId===b.authorizationId)),false);
  assert.equal((await f.finance.revokeAdvisorAuthorization({actor:f.owner,policyId:f.input.policyId,authorizationId:next.authorizations[0].authorizationId,traceId:randomUUID()})).status,'ok');
});
test('eligibility denial is audited once and unavailable audit blocks it; ordinary sessions never gain advisor powers',async()=>{
  const f=await fixture(),identity={providerSubject:'synthetic',sessionReference:'synthetic',emailVerified:true};
  const access=new ApiAccess({find:async()=>null},{find:async()=>f.owner,open:async()=>f.owner,revoke:async()=>{}});
  assert.deepEqual(await access.webUser(identity,'policies:manage-delegated'),{allowed:false,error:'forbidden',status:403});
  let calls=0;const deps={authorize:async()=>({allowed:true as const,actor:{kind:'user' as const,channel:'web' as const,principal:f.owner,operations:['policies:manage' as const]}}),advisors:{eligible:async()=>null},security:{deny:async()=>{calls++;}}};
  const input={kind:'web',advisorReference:f.advisor.advisorReference,traceId:randomUUID()};
  assert.equal((await authorizeAdvisorApproval(deps,input)).allowed,false);assert.equal(calls,1);
  assert.deepEqual(await authorizeAdvisorApproval({...deps,security:{deny:async()=>{throw Error('audit_down');}}},input),{allowed:false,error:'access_unavailable',status:503});
});
test('advisor HTTP validates actor/command and its safe list satisfies the published contract',async()=>{
  const f=await fixture(),app=new Hono<{Bindings:PolicyEnv}>();
  mountAdvisor(app,{finance:f.finance,approve:async()=>({allowed:true,actor:{kind:'user',channel:'web',principal:f.owner,operations:['policies:manage']},advisor:f.input.advisor}),
    authorize:async()=>({allowed:true,actor:{kind:'user',channel:'web',principal:f.owner,operations:['policies:manage']}}),deny:async()=>({recorded:true})},async request=>request.json());
  // These tests use an explicit synthetic Identity boundary; CSRF enforcement is covered by Identity's own policy suite.
  const path=`https://web.example/api/v1/policies/${f.input.policyId}/advisor-authorizations`;
  const response=await app.request(path,undefined,{APP_ENV:'local'} as PolicyEnv);assert.equal(response.status,200);
  const spec=parse(readFileSync('packages/contracts/openapi/v1/advisor-authorizations.yaml','utf8')),ajv=new Ajv({strict:false});addFormats(ajv);ajv.addSchema({...spec,$id:'https://test/advisors'});
  const valid=ajv.getSchema('https://test/advisors#/components/schemas/ApprovalList');assert.ok(valid);assert.equal(valid(await response.json()),true,JSON.stringify(valid.errors));
  assert.equal((await app.request(path,{headers:{authorization:'Bearer synthetic'}},{APP_ENV:'local'} as PolicyEnv)).status,400);
  assert.equal((await app.request(path,{method:'DELETE'},{APP_ENV:'local'} as PolicyEnv)).status,405);
});
