import type { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { PolicyFinance } from '../../application/policy-finance';
import { iso, object, UUID } from '../../domain/financial';
import type { AdvisorIdentity, AdvisorTarget } from '../../domain/advisor-authorization';

export type AdvisorHttpDependencies = {
  finance: Pick<PolicyFinance, 'createAdvisorAuthorization' | 'listAdvisorAuthorizations' | 'revokeAdvisorAuthorization' | 'advisorAuthorizations' | 'changeAdvisorLifecycle'>;
  authorize(input: unknown): Promise<unknown>; approve(input: unknown): Promise<unknown>; deny(input: unknown): Promise<unknown>;
};
const principal = (v: unknown): v is { clientId: string; subjectToken: string } => object(v)
  && typeof v.clientId==='string' && UUID.test(v.clientId) && typeof v.subjectToken==='string' && UUID.test(v.subjectToken);
const fresh = (v: unknown): v is string => iso(v) && Date.parse(v)>Date.now() && Date.parse(v)<=Date.now()+5500;

export function mountAdvisor(app: Hono<{ Bindings: PolicyEnv }>, deps: AdvisorHttpDependencies, body: (request: Request)=>Promise<unknown>) {
  for (const [path,mode] of [
    ['/api/v1/policies/:policyId/advisor-authorizations','owner'],
    ['/api/v1/policies/:policyId/advisor-authorizations/:authorizationId/revoke','revoke'],
    ['/api/v1/advisor-authorizations','advisor'],
    ['/api/v1/advisor-authorizations/:authorizationId/lifecycle','execute'],
  ] as const) app.all(path, async c=> {
    const supplied=c.req.header('x-trace-id')??'', traceId=UUID.test(supplied)?supplied.toLowerCase():crypto.randomUUID();
    const reply=(value: object,status:200|400|401|403|404|405|409|503)=>c.json({...value,traceId},status,
      {'x-trace-id':traceId,'cache-control':'no-store','x-content-type-options':'nosniff'});
    let timer:ReturnType<typeof setTimeout>|undefined;
    const deadline=<T>(work:Promise<T>)=>Promise.race([work,new Promise<never>((_,reject)=>{ timer=setTimeout(()=>reject(Error('access_deadline')),2000); })]).finally(()=>clearTimeout(timer));
    try {
      const method=c.req.method, writes=method==='POST';
      if (mode==='owner' ? !['GET','POST'].includes(method) : method!==(mode==='advisor'?'GET':'POST')) {
        c.header('Allow',mode==='owner'?'GET, POST':mode==='advisor'?'GET':'POST');return reply({error:'method_not_allowed'},405);
      }
      if (c.req.header('authorization')!==undefined) return reply({error:'invalid_request'},400);
      const policyId=c.req.param('policyId')?.toLowerCase(), authorizationId=c.req.param('authorizationId')?.toLowerCase();
      const query=new URL(c.req.url).searchParams;
      const after=query.get('after')??undefined;
      if ((policyId&&!UUID.test(policyId)) || (authorizationId&&!UUID.test(authorizationId)) || (query.size>0 && (writes || (mode!=='owner'&&mode!=='advisor') || query.size!==1 || query.getAll('after').length!==1 || !after || after.length>80))) return reply({error:'invalid_request'},400);
      const input=writes && mode!=='revoke'?await body(c.req.raw):null;
      if (mode==='owner' && writes && (!object(input)||Object.keys(input).length!==5||typeof input.advisorReference!=='string'||!UUID.test(input.advisorReference))) return reply({error:'invalid_request'},400);
      if (mode==='execute' && (!object(input)||Object.keys(input).length!==1||typeof input.reason!=='string')) return reply({error:'invalid_request'},400);
      const operation=mode==='advisor'||mode==='execute'?'policies:manage-delegated':'policies:manage';
      const request={kind:'web',operation,traceId,method,requestOrigin:new URL(c.req.url).origin,origin:c.req.header('origin')??'',
        cookie:getCookie(c,(c.env.APP_ENV==='local'?'':'__Host-')+'solventa-session')??''};
      const access=await deadline(mode==='owner'&&writes&&object(input)?deps.approve({...request,advisorReference:input.advisorReference}):deps.authorize(request));
      if (!object(access)) return reply({error:'access_unavailable'},503);
      if (access.allowed!==true) {
        if ((access.status===400&&access.error==='invalid_request')||(access.status===401&&access.error==='unauthorized')||(access.status===403&&access.error==='forbidden')) return reply({error:access.error},access.status);
        return reply({error:'access_unavailable'},503);
      }
      const a=access.actor;
      if (!object(a)||a.kind!=='user'||a.channel!=='web'||!principal(a.principal)||!Array.isArray(a.operations)||!a.operations.includes(operation)) return reply({error:'access_unavailable'},503);
      const owner={clientId:a.principal.clientId.toLowerCase(),subjectToken:a.principal.subjectToken.toLowerCase()};
      let advisor:AdvisorIdentity|undefined;
      if (operation==='policies:manage-delegated') {
        if (!object(a.advisorPermission)||typeof a.advisorPermission.reference!=='string'||!UUID.test(a.advisorPermission.reference)
          ||!fresh(a.authorizationExpiresAt)||a.advisorPermission.expiresAt!==a.authorizationExpiresAt) return reply({error:'access_unavailable'},503);
        advisor={...owner,advisorReference:a.advisorPermission.reference.toLowerCase(),authorizationExpiresAt:a.authorizationExpiresAt};
      }
      const key=c.req.header('idempotency-key')??'';
      let result;
      if (mode==='advisor'&&advisor) result=await deps.finance.advisorAuthorizations({actor:advisor,traceId,after});
      else if (mode==='execute'&&advisor&&authorizationId&&object(input)&&typeof input.reason==='string') result=await deps.finance.changeAdvisorLifecycle({actor:advisor,authorizationId,reason:input.reason,idempotencyKey:key,traceId});
      else if (mode==='revoke'&&policyId&&authorizationId) result=await deps.finance.revokeAdvisorAuthorization({actor:owner,policyId,authorizationId,traceId});
      else if (mode==='owner'&&policyId&&!writes) result=await deps.finance.listAdvisorAuthorizations({actor:owner,policyId,traceId,after});
      else if (mode==='owner'&&policyId&&object(input)) {
        const t=access.advisor;
        if (!object(t)||!principal(t.principal)||typeof t.reference!=='string'||!UUID.test(t.reference)||!fresh(t.expiresAt)
          ||t.reference.toLowerCase()!==String(input.advisorReference).toLowerCase()) return reply({error:'access_unavailable'},503);
        if (typeof input.action!=='string'||!['modified','renewed','cancelled'].includes(input.action)||typeof input.documentHash!=='string'
          ||typeof input.expiresAt!=='string'||!(input.replacementPolicyId===null||typeof input.replacementPolicyId==='string')) return reply({error:'invalid_request'},400);
        const target:AdvisorTarget={principal:t.principal,reference:t.reference.toLowerCase(),expiresAt:t.expiresAt};
        result=await deps.finance.createAdvisorAuthorization({actor:owner,advisor:target,policyId,action:input.action as 'modified'|'renewed'|'cancelled',
          documentHash:input.documentHash,replacementPolicyId:input.replacementPolicyId===null?null:input.replacementPolicyId.toLowerCase(),expiresAt:input.expiresAt,idempotencyKey:key,traceId});
      } else return reply({error:'invalid_request'},400);
      if (advisor&&!fresh(advisor.authorizationExpiresAt)) return reply({error:'access_unavailable'},503);
      if (result.status==='ok') return reply({...result,...(advisor&&mode==='advisor'?{advisorReference:advisor.advisorReference}:{})},200);
      if (result.httpStatus===404||result.httpStatus===403) {
        const denial=await deadline(deps.deny({operation,traceId}));
        if (!object(denial)||denial.recorded!==true) return reply({error:'access_unavailable'},503);
      }
      return reply({error:result.error},result.httpStatus);
    } catch { return reply({error:'financial_unavailable'},503); }
    finally { clearTimeout(timer); if(c.req.raw.body&&!c.req.raw.bodyUsed) await c.req.raw.body.cancel().catch(()=>{}); }
  });
}
