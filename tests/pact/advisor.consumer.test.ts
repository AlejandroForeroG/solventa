import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { PactV3, MatchersV3 } from '@pact-foundation/pact';
import { executeApproval } from '../../apps/web/src/advisor/api';
import { advisorIds } from './support/advisor';
import { lifecycleIds } from './support/policy-lifecycle';
import { assertMatchesCommitted, pactOutputDir, providerName } from './support/pact-files';

const consumer='solventa-advisor-web',dir=pactOutputDir(),pact=new PactV3({consumer,provider:providerName,dir,logLevel:'error'});
after(()=>assertMatchesCommitted(dir,`${consumer}-${providerName}.json`));
for(const mode of ['ready','revoked','unavailable'] as const)test(`advisor executes only a current concrete customer approval: ${mode}`,async()=>{
  const status=mode==='ready'?200:mode==='revoked'?404:503;
  pact.given(`advisor approval ${mode}`).uponReceiving(`an authorized advisor execution with ${mode} approval`)
    .withRequest({method:'POST',path:`/api/v1/advisor-authorizations/${advisorIds.authorizationId}/lifecycle`,headers:{'content-type':'application/json','idempotency-key':'advisor-cancel-1'},body:{reason:'customer_request'}})
    .willRespondWith({status,headers:{'Content-Type':'application/json'},body:status===200?{status:'ok',policyId:lifecycleIds.policyId,changeId:MatchersV3.uuid('02000000-0000-4000-8000-000000000005'),action:'cancelled',changedAt:MatchersV3.iso8601DateTimeWithMillis('2026-11-11T12:00:00.000Z'),replayed:false,traceId:MatchersV3.uuid('50000000-0000-4000-8000-000000000001')}:{error:mode==='revoked'?'not_found':'financial_unavailable',traceId:MatchersV3.uuid('50000000-0000-4000-8000-000000000001')}});
  await pact.executeTest(async server=>{
    const original=globalThis.fetch;globalThis.fetch=(input,init)=>original(typeof input==='string'&&input.startsWith('/')?server.url+input:input,init);
    try{const result=await executeApproval({authorizationId:advisorIds.authorizationId,advisorReference:advisorIds.reference,policyId:lifecycleIds.policyId,action:'cancelled',replacementPolicyId:null,documentHash:'a'.repeat(64),grantedAt:'2026-11-11T00:00:00.000Z',expiresAt:'2026-11-12T00:00:00.000Z',status:'active',changeId:null,revokedAt:null},'advisor-cancel-1');assert.equal(result.kind,mode==='ready'?'ok':mode==='revoked'?'forbidden':'unavailable');}
    finally{globalThis.fetch=original;}
  });
});
