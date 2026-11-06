export const OPEN_CLAIM_STATES = ['unassigned', 'in_review', 'pending_information', 'escalated'] as const;
export const CLAIM_STATES = [...OPEN_CLAIM_STATES, 'approved', 'rejected', 'paid'] as const;
export type ClaimState = typeof CLAIM_STATES[number];
export type ClaimPriority = 'high' | 'medium' | 'low';
export type ClaimEvidence = { provided: number; required: number; status: 'complete' | 'incomplete' | 'in_review' };
export type ClaimSummary = { claimId: string; claimNumber: string; policyId: string; state: ClaimState; priority: ClaimPriority;
  openedAt: string; ageDays: number; overdue: boolean; estimatedAmount: string; currency: string; evidence: ClaimEvidence; assigneeId: string | null };

// Provisional thresholds in calendar days. The SQL ordering receives the same values, so there is one definition.
export const HIGH_PRIORITY_DAYS = 5;
export const MEDIUM_PRIORITY_DAYS = 2;
export const OVERDUE_DAYS = HIGH_PRIORITY_DAYS;

export const isClaimState = (value: unknown): value is ClaimState => CLAIM_STATES.some(state => state === value);
export const isOpenClaimState = (state: ClaimState) => OPEN_CLAIM_STATES.some(open => open === state);

// Colombia has no daylight saving time, so a fixed UTC-5 offset gives the Bogotá calendar day.
const BOGOTA_OFFSET_MS = 5 * 3_600_000;
const dayIndex = (instant: Date) => Math.floor((instant.getTime() - BOGOTA_OFFSET_MS) / 86_400_000);
export function ageDays(openedAt: Date, now: Date): number {
  return Math.max(0, dayIndex(now) - dayIndex(openedAt));
}
export function priorityOf(state: ClaimState, age: number): ClaimPriority {
  if (state === 'escalated' || age >= HIGH_PRIORITY_DAYS) return 'high';
  return age >= MEDIUM_PRIORITY_DAYS ? 'medium' : 'low';
}
export function evidenceOf(provided: number, required: number, unverified: number): ClaimEvidence {
  if (provided < required) return { provided, required, status: 'incomplete' };
  return { provided, required, status: unverified > 0 ? 'in_review' : 'complete' };
}

export type OpenClaimRecord = { id: string; claimNumber: string; policyId: string; state: ClaimState; openedAt: Date; estimatedAmount: string;
  currency: string; assigneeId: string | null; provided: number; required: number; unverified: number };
export class InvalidClaimRecord extends Error {}

export function summarize(record: OpenClaimRecord, now: Date): ClaimSummary {
  if (!isOpenClaimState(record.state) || !/^SIN-\d{4}-\d{5}$/.test(record.claimNumber) || !/^(0|[1-9][0-9]{0,14})\.[0-9]{4}$/.test(record.estimatedAmount)
    || !/^[A-Z]{3}$/.test(record.currency) || !Number.isInteger(record.provided) || !Number.isInteger(record.required) || !Number.isInteger(record.unverified)
    || record.provided < 0 || record.required < 0 || record.unverified < 0 || record.unverified > record.provided) throw new InvalidClaimRecord();
  const age = ageDays(record.openedAt, now);
  return { claimId: record.id, claimNumber: record.claimNumber, policyId: record.policyId, state: record.state, priority: priorityOf(record.state, age),
    openedAt: record.openedAt.toISOString(), ageDays: age, overdue: age >= OVERDUE_DAYS, estimatedAmount: record.estimatedAmount, currency: record.currency,
    evidence: evidenceOf(record.provided, record.required, record.unverified), assigneeId: record.assigneeId };
}
