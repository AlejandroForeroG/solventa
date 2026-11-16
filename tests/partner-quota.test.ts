import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityApiAccess } from '../backend/acquisition-risk/src/adapters/outbound/identity-api-access';
import { IdentityPartnerOfferAccess } from '../backend/acquisition-risk/src/adapters/outbound/identity-partner-offer-access';
import { admitPartnerRequest } from '../backend/identity-consent-ecosystem/src/application/partner-quota';
import { portalApp } from './support/partner-portal-fakes';
import { contractSchema } from './support/openapi-schemas';
import { isPortalData } from '../apps/web/src/partner-portal/api';
import example from '../packages/contracts/examples/partner-portal-v2.json';
import { Hono } from 'hono';
import { CreateQuote } from '../backend/acquisition-risk/src/application/create-quote';
import { PartnerOffers } from '../backend/acquisition-risk/src/application/partner-offers';
import { quotesHandler } from '../backend/acquisition-risk/src/adapters/inbound/quotes-http';
import { mountPartnerOffers } from '../backend/acquisition-risk/src/adapters/inbound/partner-offers-http';
import { MemoryStore, protector } from './support/quote-fakes';
import worker from '../apps/web/worker/index';
import { advisorPactWorld, advisorIds } from './pact/support/advisor';

test('both partner admission adapters preserve a validated 429 and reject forged retry metadata',async()=>{
  for(const retryAfter of [3600,0,-1,86401,'3600',NaN]) {
    const reply={allowed:false,status:429,error:'quota_exceeded',retryAfter};
    const quote=await new IdentityApiAccess({authorizeApiAccessV1:async()=>reply}).authorize({kind:'partner',token:'synthetic'});
    const offer=await new IdentityPartnerOfferAccess({authorizePartnerOfferAccessV1:async()=>reply}).authorize({token:'synthetic',authorizationId:example.partner.id,traceId:example.traceId});
    for(const result of [quote,offer]) assert.deepEqual(result,retryAfter===3600?reply:{allowed:false,status:503,error:'access_unavailable'});
  }
});
test('admission never consumes after access denial and fails closed on counter outage',async()=>{
  let calls=0;const quotas={admit:async()=>{calls++;throw Error('synthetic_SQL_failure');}};
  const denied={allowed:false,error:'forbidden',status:403} as const;
  assert.equal(await admitPartnerRequest(denied,example.partner.id,quotas),denied);assert.equal(calls,0);
  assert.deepEqual(await admitPartnerRequest({allowed:true},example.partner.id,quotas),{allowed:false,error:'access_unavailable',status:503});assert.equal(calls,1);
});
test('v2 portal exposes configured daily quota independently of the requested historical period',async()=>{
  const response=await portalApp('ready',true).request('https://dev.solventa.site/api/v2/partner-portal?from=2026-11-01&to=2026-11-07',undefined,{APP_ENV:'dev'} as AcquisitionEnv);
  assert.equal(response.status,200);const body=await response.json();assert.equal(body.quota.limit,1000);assert.equal(body.quota.remaining,998);
  assert.equal(body.period.to,'2026-11-07');assert.equal(body.quota.windowStart,new Date().toISOString().slice(0,10)+'T00:00:00.000Z');
  const schema=contractSchema('partner-portal','PartnerPortal','v2');assert.equal(schema(body).valid,true,schema(body).errors);assert.ok(isPortalData(body));
  assert.equal((await portalApp('ready',true).request('https://dev.solventa.site/api/v1/partner-portal?from=2026-11-01&to=2026-11-07',undefined,{APP_ENV:'dev'} as AcquisitionEnv)).status,503);
  assert.equal((await portalApp().request('https://dev.solventa.site/api/v2/partner-portal?from=2026-11-01&to=2026-11-07',undefined,{APP_ENV:'dev'} as AcquisitionEnv)).status,503);
  for(const quota of [{...example.quota,remaining:999},{...example.quota,used:-1},{...example.quota,limit:0},{...example.quota,resetsAt:example.quota.windowStart}])assert.equal(isPortalData({...example,quota}),false);
});
test('both real HTTP handlers preserve 429 Retry-After and start no downstream business work',async()=>{
  let effects=0;const unexpected=async():Promise<never>=>{effects++;throw Error('unexpected_business_effect');};
  const denied={allowed:false,error:'quota_exceeded',status:429,retryAfter:1200} as const;
  const quotes=new CreateQuote({access:{authorize:async()=>denied},store:new MemoryStore(),protector,clock:{now:()=>new Date()}});
  const offers=new PartnerOffers({access:{authorize:async()=>denied},quotes:{createFor:unexpected},offers:{create:unexpected,explanation:unexpected},protector:{partnerKey:unexpected}});
  const app=new Hono<{Bindings:AcquisitionEnv}>();app.post('/api/v1/quotes',quotesHandler(quotes,'partner'));mountPartnerOffers(app,{offers});
  for(const path of ['/api/v1/quotes','/api/v1/partner/offers']){
    const response=await app.request('https://dev.solventa.site'+path,{method:'POST',headers:{authorization:'Bearer synthetic','content-type':'application/json','idempotency-key':'same-business-retry'},body:JSON.stringify({authorizationId:example.partner.id})},{APP_ENV:'dev'} as AcquisitionEnv);
    assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'1200');assert.equal(response.headers.get('cache-control'),'no-store');
    const body=await response.json();assert.equal(body.error,'quota_exceeded');assert.equal(body.traceId,response.headers.get('x-trace-id'));
  }
  assert.equal(effects,0);
});
test('the web gateway preserves the advisor JSON command up to its real Policy handler',async()=>{
  const policy=await advisorPactWorld('ready');
  const response=await worker.fetch(new Request(`https://web.example/api/v1/advisor-authorizations/${advisorIds.authorizationId}/lifecycle`,{
    method:'POST',headers:{'content-type':'application/json',origin:'https://web.example','idempotency-key':'gateway-advisor'},body:JSON.stringify({reason:'customer_request'})}),
    {APP_ENV:'dev',POLICY:{fetch:(request:Request)=>policy.request(request,undefined,{APP_ENV:'dev'} as PolicyEnv)}} as never);
  assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).action,'cancelled');
});
