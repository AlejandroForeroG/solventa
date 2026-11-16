import { canonical, HEX, iso, object, UUID } from './financial';
export type LifecycleAction = 'modified' | 'renewed' | 'cancelled';
export type LifecycleChange = {
  changeId: string; policyId: string; action: LifecycleAction; reason: string; at: string;
  replacementPolicyId: string | null; sourceDocumentHash: string; replacementDocumentHash: string | null;
  refund: 'not_automated'; ruleVersion: 'academic-policy-lifecycle-1'; documentHash: string;
};
export function lifecycleContent(change: Omit<LifecycleChange, 'documentHash'>): string {
  const { changeId, policyId, action, reason, at, replacementPolicyId, sourceDocumentHash, replacementDocumentHash, refund, ruleVersion } = change;
  return canonical({ changeId, policyId, action, reason, at, replacementPolicyId, sourceDocumentHash, replacementDocumentHash, refund, ruleVersion });
}
export function isLifecycleChange(value: unknown): value is LifecycleChange {
  if (!object(value) || Object.keys(value).length !== 11) return false;
  return typeof value.changeId === 'string' && UUID.test(value.changeId) && typeof value.policyId === 'string' && UUID.test(value.policyId)
    && typeof value.action === 'string' && ['modified', 'renewed', 'cancelled'].includes(value.action) && typeof value.reason === 'string'
    && /^[a-z][a-z_]{2,63}$/.test(value.reason) && iso(value.at)
    && typeof value.sourceDocumentHash === 'string' && HEX.test(value.sourceDocumentHash)
    && typeof value.documentHash === 'string' && HEX.test(value.documentHash)
    && value.refund === 'not_automated' && value.ruleVersion === 'academic-policy-lifecycle-1'
    && (value.action === 'cancelled' ? value.replacementPolicyId === null && value.replacementDocumentHash === null
      : typeof value.replacementPolicyId === 'string' && UUID.test(value.replacementPolicyId) && value.replacementPolicyId !== value.policyId
        && typeof value.replacementDocumentHash === 'string' && HEX.test(value.replacementDocumentHash));
}
