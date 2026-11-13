import { fetchWithSession } from '../session-fetch';

export type Approval = { authorizationId:string; advisorReference:string; policyId:string; action:'modified'|'renewed'|'cancelled'; replacementPolicyId:string|null;
  documentHash:string; grantedAt:string; expiresAt:string; status:'active'|'expired'|'revoked'|'executed'; changeId:string|null; revokedAt:string|null };
export type ApprovalList = { authorizations:Approval[]; hasMore:boolean; nextCursor:string|null; advisorReference?:string };
export type Outcome<T> = {kind:'ok';value:T}|{kind:'unauthenticated'|'forbidden'|'invalid'|'conflict'|'unavailable'};
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const instant=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(v)&&Number.isFinite(Date.parse(v));
export const validApproval=(v:unknown):v is Approval=>record(v)&&uuid(v.authorizationId)&&uuid(v.advisorReference)&&uuid(v.policyId)
  &&typeof v.action==='string'&&['modified','renewed','cancelled'].includes(v.action)
  &&(v.action==='cancelled'?v.replacementPolicyId===null:uuid(v.replacementPolicyId)&&v.replacementPolicyId!==v.policyId)
  &&typeof v.documentHash==='string'&&/^[0-9a-f]{64}$/.test(v.documentHash)&&instant(v.grantedAt)&&instant(v.expiresAt)
  &&Date.parse(v.expiresAt)>Date.parse(v.grantedAt)&&Date.parse(v.expiresAt)-Date.parse(v.grantedAt)<=7*86400000
  &&typeof v.status==='string'&&['active','expired','revoked','executed'].includes(v.status)&&(v.changeId===null||uuid(v.changeId))
  &&(v.status==='executed'?uuid(v.changeId):v.changeId===null)&&(v.revokedAt===null||instant(v.revokedAt))
  &&(v.status==='revoked'?instant(v.revokedAt):v.status==='active'?v.revokedAt===null:true);
async function request<T>(path:string,options:RequestInit,valid:(v:Record<string,unknown>)=>T|null):Promise<Outcome<T>> {
  try {
    const response=await fetchWithSession(path,{cache:'no-store',...options});
    if(response.status===401)return{kind:'unauthenticated'};
    if(response.status===403||response.status===404)return{kind:'forbidden'};
    if(response.status===400)return{kind:'invalid'};
    if(response.status===409)return{kind:'conflict'};
    const body:unknown=await response.json();
    const value=response.status===200&&record(body)&&uuid(body.traceId)?valid(body):null;
    return value===null?{kind:'unavailable'}:{kind:'ok',value};
  } catch{return{kind:'unavailable'};}
}
export function readApprovals(policyId:string|null,signal?:AbortSignal,after?:string):Promise<Outcome<ApprovalList>> {
  const path=(policyId?`/api/v1/policies/${encodeURIComponent(policyId)}/advisor-authorizations`:'/api/v1/advisor-authorizations')+(after?'?'+new URLSearchParams({after}):'');
  return request(path,{method:'GET',signal},v=>{
    if(!Array.isArray(v.authorizations)||v.authorizations.length>20||!v.authorizations.every(validApproval)||typeof v.hasMore!=='boolean'||(v.hasMore&&(typeof v.nextCursor!=='string'||v.nextCursor.length>80||!/^\d{4}-.*\|[a-f0-9-]{36}$/i.test(v.nextCursor)))
      ||(policyId?v.authorizations.some(a=>a.policyId!==policyId):!uuid(v.advisorReference)||v.authorizations.some(a=>a.advisorReference!==v.advisorReference)))return null;
    return{authorizations:v.authorizations,hasMore:v.hasMore,nextCursor:typeof v.nextCursor==='string'?v.nextCursor:null,...(uuid(v.advisorReference)?{advisorReference:v.advisorReference}:{})};
  });
}
export type ApprovalCommand={advisorReference:string;action:Approval['action'];replacementPolicyId:string|null;documentHash:string;expiresAt:string};
export async function grantApproval(policyId:string,input:Omit<ApprovalCommand,'documentHash'>,key:string):Promise<Outcome<Approval>> {
  const hash=await request(`/api/v1/policies/${encodeURIComponent(policyId)}`,{method:'GET'},v=>typeof v.documentHash==='string'&&/^[0-9a-f]{64}$/.test(v.documentHash)?v.documentHash:null);
  if(hash.kind!=='ok')return hash;
  return request(`/api/v1/policies/${encodeURIComponent(policyId)}/advisor-authorizations`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify({...input,documentHash:hash.value})},v=>
    validApproval(v.authorization)&&v.authorization.policyId===policyId&&v.authorization.advisorReference===input.advisorReference.toLowerCase()
      &&v.authorization.action===input.action&&v.authorization.replacementPolicyId===input.replacementPolicyId&&v.authorization.documentHash===hash.value&&Date.parse(v.authorization.expiresAt)===Date.parse(input.expiresAt)?v.authorization:null);
}
export const revokeApproval=(approval:Approval)=>request(`/api/v1/policies/${encodeURIComponent(approval.policyId)}/advisor-authorizations/${encodeURIComponent(approval.authorizationId)}/revoke`,{method:'POST'},v=>
  validApproval(v.authorization)&&v.authorization.authorizationId===approval.authorizationId&&v.authorization.revokedAt!==null&&['revoked','executed'].includes(v.authorization.status)?v.authorization:null);
export const executeApproval=(approval:Approval,key:string)=>request(`/api/v1/advisor-authorizations/${encodeURIComponent(approval.authorizationId)}/lifecycle`,
  {method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify({reason:approval.action==='modified'?'coverage_change':approval.action==='renewed'?'term_renewal':'customer_request'})},v=>
    uuid(v.changeId)&&v.policyId===approval.policyId&&v.action===approval.action&&instant(v.changedAt)&&typeof v.replayed==='boolean'?{changeId:v.changeId}:null);
