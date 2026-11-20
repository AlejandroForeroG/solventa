export const CLAIM_CASE_STATES = ['unassigned', 'in_review', 'pending_information', 'escalated', 'approved', 'rejected', 'paid'] as const;
export type ClaimCaseState = typeof CLAIM_CASE_STATES[number];
export const CLAIM_CASE_EVENTS = ['submitted', 'take', 'request_information', 'extend_requirement', 'respond', 'assign_expert', 'approve', 'reject',
  'disbursement_confirmed', 'disbursement_declined'] as const;
export type ClaimCaseEvent = typeof CLAIM_CASE_EVENTS[number];
export type OwnedClaim = { claimId: string; claimNumber: string; state: ClaimCaseState };
export type CustomerClaimCase = {
  claimNumber: string; state: ClaimCaseState;
  history: { id: string; action: ClaimCaseEvent; at: string; state: ClaimCaseState }[];
  requirements: { id: string; details: string; deadline: string; status: 'pending' | 'received' }[];
};

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isClaimCaseId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const number = (value: unknown): value is string => typeof value === 'string' && /^SIN-\d{4}-\d{5}$/.test(value);
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const state = (value: unknown): value is ClaimCaseState => CLAIM_CASE_STATES.some(item => item === value);
const event = (value: unknown): value is ClaimCaseEvent => CLAIM_CASE_EVENTS.some(item => item === value);

export function parseOwnedClaimList(value: unknown): OwnedClaim[] | null {
  if (!record(value) || !isClaimCaseId(value.traceId) || !Array.isArray(value.items) || value.items.length > 25) return null;
  const result: OwnedClaim[] = [];
  for (const item of value.items) {
    if (!record(item) || !isClaimCaseId(item.claimId) || !number(item.claimNumber) || !state(item.state)) return null;
    result.push({ claimId: item.claimId, claimNumber: item.claimNumber, state: item.state });
  }
  return result;
}

export function parseCustomerClaimCase(value: unknown): CustomerClaimCase | null {
  if (!record(value) || value.access !== 'customer' || !isClaimCaseId(value.traceId) || !number(value.claimNumber)
    || !state(value.state) || !Array.isArray(value.history) || value.history.length > 26
    || !Array.isArray(value.requirements) || value.requirements.length > 25) return null;
  const requirements: CustomerClaimCase['requirements'] = [];
  for (const item of value.requirements) {
    if (!record(item) || !isClaimCaseId(item.id) || typeof item.details !== 'string' || !date(item.deadline)
      || (item.status !== 'pending' && item.status !== 'received')) return null;
    requirements.push({ id: item.id, details: item.details, deadline: item.deadline, status: item.status });
  }
  const history: CustomerClaimCase['history'] = [];
  for (const item of value.history) {
    if (!record(item) || !isClaimCaseId(item.id) || !event(item.action) || !date(item.at) || !state(item.state)
      || item.reason !== null || item.expert !== null || item.actorId !== null) return null;
    history.push({ id: item.id, action: item.action, at: item.at, state: item.state });
  }
  return { claimNumber: value.claimNumber, state: value.state, requirements, history };
}
