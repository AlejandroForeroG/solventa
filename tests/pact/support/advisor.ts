import { createHttp } from '../../../backend/policy-claims-payments/src/adapters/inbound/http';
import { lifecycleFixture } from '../../support/policy-lifecycle-fixture';
import { lifecyclePactRecord, lifecyclePrincipal } from './policy-lifecycle';
export const advisorIds={authorizationId:'02000000-0000-4000-8000-000000000001',reference:'02000000-0000-4000-8000-000000000002',clientId:'02000000-0000-4000-8000-000000000003',subjectToken:'02000000-0000-4000-8000-000000000004'};
export async function advisorPactWorld(mode:'ready'|'revoked'|'unavailable') {
  let sequence=0;
  const f=lifecycleFixture([await lifecyclePactRecord()],()=>sequence++===0?advisorIds.authorizationId:'02000000-0000-4000-8000-000000000005');
  const now=new Date();f.setNow(now.toISOString());
  const advisor={clientId:advisorIds.clientId,subjectToken:advisorIds.subjectToken};
  const source=await lifecyclePactRecord();
  const created=await f.finance.createAdvisorAuthorization({actor:lifecyclePrincipal,advisor:{principal:advisor,reference:advisorIds.reference,expiresAt:new Date(Date.now()+5000).toISOString()},
    policyId:source.policy.id,action:'cancelled',replacementPolicyId:null,documentHash:source.policy.documentHash,expiresAt:new Date(now.getTime()+86400000).toISOString(),idempotencyKey:'pact-approval',traceId:'50000000-0000-4000-8000-000000000001'});
  if(created.status!=='ok')throw Error('advisor_fixture_failed');
  if(mode==='revoked')await f.finance.revokeAdvisorAuthorization({actor:lifecyclePrincipal,policyId:source.policy.id,authorizationId:advisorIds.authorizationId,traceId:'50000000-0000-4000-8000-000000000002'});
  if(mode==='unavailable')f.fail();
  return createHttp({finance:f.finance,denyResourceAccess:async()=>({recorded:true}),authorizeFinancialAccess:async()=>({allowed:false,status:403,error:'forbidden'}),
    advisor:{finance:f.finance,approve:async()=>({allowed:false,status:403,error:'forbidden'}),deny:async()=>({recorded:true}),authorize:async()=>{
      f.setNow(new Date().toISOString());const expiresAt=new Date(Date.now()+5000).toISOString();
      return{allowed:true,actor:{kind:'user',channel:'web',principal:advisor,operations:['policies:manage-delegated'],authorizationExpiresAt:expiresAt,advisorPermission:{reference:advisorIds.reference,expiresAt}}};
    }}});
}
