import { canonical, HEX, iso, object, UUID } from './financial';
import type { FinancialActor, FinancialResult } from './financial';
import type { LifecycleAction } from './policy-lifecycle';

export type AdvisorAuthorization = {
  id: string; policyId: string; owner: FinancialActor; advisor: FinancialActor; advisorReference: string;
  action: LifecycleAction; documentHash: string; replacementPolicyId: string | null; replacementDocumentHash: string | null;
  grantedAt: string; expiresAt: string; ruleVersion: 'policy-advisor-authorization-1'; seal: string;
};
export type AdvisorAuthorizationRecord = { authorization: AdvisorAuthorization; revokedAt: string | null; changeId: string | null };
export type AdvisorAuthorizationView = {
  authorizationId: string; advisorReference: string; policyId: string; action: LifecycleAction;
  replacementPolicyId: string | null; documentHash: string; grantedAt: string; expiresAt: string;
  status: 'active' | 'expired' | 'revoked' | 'executed'; changeId: string | null;
};
export type AdvisorIdentity = FinancialActor & { advisorReference: string; authorizationExpiresAt: string };
export type AdvisorTarget = { principal: FinancialActor; reference: string; expiresAt: string };
export type DelegatedLifecycleExecution = { authorizationId: string; ownerClientId: string; advisorClientId: string;
  advisorReference: string; grantedAt: string; expiresAt: string; authorizationExpiresAt: string; authorizationSeal: string };
type Failed = Extract<FinancialResult, { status: 'denied' | 'unavailable' }>;
export type AdvisorApprovalResult = { status: 'ok'; authorization: AdvisorAuthorizationView; replayed: boolean } | Failed;
export type AdvisorAuthorizationsResult = { status: 'ok'; authorizations: AdvisorAuthorizationView[]; hasMore: boolean; nextCursor:string|null } | Failed;
export type AdvisorLifecycleResult = { status: 'ok'; policyId: string; changeId: string; action: LifecycleAction; changedAt: string; replayed: boolean } | Failed;
export const ADVISOR_AUTHORIZATION_RULE = 'policy-advisor-authorization-1';
export const validFinancialActor = (actor: FinancialActor) => UUID.test(actor.clientId) && UUID.test(actor.subjectToken);
export function advisorAuthorizationContent(value: Omit<AdvisorAuthorization, 'seal'>): string {
  const { id, policyId, owner, advisor, advisorReference, action, documentHash, replacementPolicyId, replacementDocumentHash, grantedAt, expiresAt, ruleVersion } = value;
  return canonical({ id, policyId, owner, advisor, advisorReference, action, documentHash, replacementPolicyId, replacementDocumentHash, grantedAt, expiresAt, ruleVersion });
}
export function isAdvisorAuthorization(value: unknown): value is AdvisorAuthorization {
  if (!object(value) || Object.keys(value).length !== 13 || !object(value.owner) || !object(value.advisor)
    || Object.keys(value.owner).length !== 2 || Object.keys(value.advisor).length !== 2) return false;
  const actor = (v: Record<string, unknown>) => typeof v.clientId === 'string' && UUID.test(v.clientId)
    && typeof v.subjectToken === 'string' && UUID.test(v.subjectToken);
  return actor(value.owner) && actor(value.advisor) && value.owner.clientId !== value.advisor.clientId
    && typeof value.id === 'string' && UUID.test(value.id) && typeof value.policyId === 'string' && UUID.test(value.policyId)
    && typeof value.advisorReference === 'string' && UUID.test(value.advisorReference)
    && typeof value.action === 'string' && ['modified', 'renewed', 'cancelled'].includes(value.action)
    && typeof value.documentHash === 'string' && HEX.test(value.documentHash) && typeof value.seal === 'string' && HEX.test(value.seal)
    && iso(value.grantedAt) && iso(value.expiresAt) && Date.parse(value.expiresAt) > Date.parse(value.grantedAt)
    && Date.parse(value.expiresAt) - Date.parse(value.grantedAt) <= 7 * 86400000 && value.ruleVersion === ADVISOR_AUTHORIZATION_RULE
    && (value.action === 'cancelled' ? value.replacementPolicyId === null && value.replacementDocumentHash === null
      : typeof value.replacementPolicyId === 'string' && UUID.test(value.replacementPolicyId) && value.replacementPolicyId !== value.policyId
        && typeof value.replacementDocumentHash === 'string' && HEX.test(value.replacementDocumentHash));
}
export function advisorAuthorizationView(record: AdvisorAuthorizationRecord, now: number): AdvisorAuthorizationView {
  const value = record.authorization;
  return { authorizationId: value.id, advisorReference: value.advisorReference, policyId: value.policyId, action: value.action,
    replacementPolicyId: value.replacementPolicyId, documentHash: value.documentHash, grantedAt: value.grantedAt, expiresAt: value.expiresAt,
    status: record.changeId ? 'executed' : record.revokedAt ? 'revoked' : Date.parse(value.expiresAt) <= now ? 'expired' : 'active', changeId: record.changeId };
}
