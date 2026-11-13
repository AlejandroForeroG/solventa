import { fetchWithSession } from '../session-fetch';

export const CLAIM_STATES = ['unassigned', 'in_review', 'pending_information', 'escalated', 'approved', 'rejected', 'paid'] as const;
export type ClaimState = typeof CLAIM_STATES[number];
export type ClaimPriority = 'high' | 'medium' | 'low';
export type ClaimEvidence = { provided: number; required: number; status: 'complete' | 'incomplete' | 'in_review' };
export type ClaimSummary = { claimId: string; claimNumber: string; policyId: string; state: ClaimState; priority: ClaimPriority; openedAt: string; ageDays: number;
  overdue: boolean; estimatedAmount: string | null; currency: string; evidence: ClaimEvidence; assigneeId: string | null };
export type ClaimsPage = { items: ClaimSummary[]; next: string | null };
export type ClaimsOutcome<T> = { kind: 'ok'; value: T } | { kind: 'unauthenticated' | 'forbidden' | 'invalid' | 'unavailable'; traceId?: string };

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function evidence(v: unknown): v is ClaimEvidence {
  return record(v) && count(v.provided) && count(v.required) && ['complete', 'incomplete', 'in_review'].includes(String(v.status));
}
function summary(v: unknown): v is ClaimSummary {
  return record(v) && uuid(v.claimId) && typeof v.claimNumber === 'string' && /^SIN-\d{4}-\d{5}$/.test(v.claimNumber) && uuid(v.policyId)
    && CLAIM_STATES.some(state => state === v.state) && ['high', 'medium', 'low'].includes(String(v.priority))
    && typeof v.openedAt === 'string' && Number.isFinite(Date.parse(v.openedAt)) && count(v.ageDays) && typeof v.overdue === 'boolean'
    && (v.estimatedAmount === null || (typeof v.estimatedAmount === 'string' && /^(0|[1-9][0-9]{0,14})\.[0-9]{4}$/.test(v.estimatedAmount)))
    && typeof v.currency === 'string' && /^[A-Z]{3}$/.test(v.currency) && evidence(v.evidence) && (v.assigneeId === null || uuid(v.assigneeId));
}

export async function listClaims(query: URLSearchParams, signal: AbortSignal): Promise<ClaimsOutcome<ClaimsPage>> {
  try {
    const response = await fetchWithSession(`/api/v1/claims${query.size ? '?' + query : ''}`, { method: 'GET', signal, cache: 'no-store', headers: { accept: 'application/json' } });
    const body: unknown = await response.json();
    const traceId = record(body) && uuid(body.traceId) ? body.traceId : undefined;
    if (response.status === 401) return { kind: 'unauthenticated', traceId };
    if (response.status === 403) return { kind: 'forbidden', traceId };
    if (response.status === 400) return { kind: 'invalid', traceId };
    if (response.status !== 200 || !traceId || !record(body) || !Array.isArray(body.items) || body.items.length > 20 || !body.items.every(summary)
      || !(body.next === null || uuid(body.next))) return { kind: 'unavailable', traceId };
    return { kind: 'ok', value: { items: body.items, next: body.next } };
  } catch (error) { if (signal.aborted) throw error; return { kind: 'unavailable' }; }
}
