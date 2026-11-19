import type { ClaimState } from './claims';

export type ClaimAction = 'approve' | 'reject';
export type ClaimDecisionInput = { action: ClaimAction; reason: string; evidenceIds: string[] };
export type ClaimDecisionContext = { state: ClaimState; assigneeId: string | null; actorId: string; requiredEvidence: number; verifiedEvidence: number };
export type ClaimDecisionError = 'not_assigned' | 'invalid_state' | 'incomplete_evidence';

export function decisionState(context: ClaimDecisionContext, input: ClaimDecisionInput): ClaimState | ClaimDecisionError {
  if (context.assigneeId !== context.actorId) return 'not_assigned';
  if (context.state !== 'in_review' && context.state !== 'escalated') return 'invalid_state';
  if (context.verifiedEvidence < context.requiredEvidence || input.evidenceIds.length === 0) return 'incomplete_evidence';
  return input.action === 'approve' ? 'approved' : 'rejected';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function parseClaimDecision(value: unknown): ClaimDecisionInput | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'action,evidenceIds,reason' || (input.action !== 'approve' && input.action !== 'reject')
    || typeof input.reason !== 'string' || input.reason.trim().length < 10 || input.reason.trim().length > 1000
    || !Array.isArray(input.evidenceIds) || input.evidenceIds.length < 1 || input.evidenceIds.length > 20) return null;
  const evidenceIds: string[] = [];
  for (const id of input.evidenceIds) {
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    evidenceIds.push(id.toLowerCase());
  }
  if (new Set(evidenceIds).size !== evidenceIds.length) return null;
  return { action: input.action, reason: input.reason.trim(), evidenceIds: evidenceIds.sort() };
}
