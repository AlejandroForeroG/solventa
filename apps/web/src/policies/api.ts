import { fetchWithSession } from '../session-fetch';

export type PolicyProduct = 'vida_hipotecario' | 'flight_delay';
export type PolicyCoverage = { kind: 'mortgage_life'; sumInsured: string }
  | { kind: 'flight_delay'; flightReference: string; thresholdMinutes: number; payoutAmount: string };
export type PolicySummary = { policyId: string; product: PolicyProduct; status: 'issued'; premium: string; currency: 'COP';
  effectiveFrom: string; effectiveUntil: string; coverage: PolicyCoverage };
export const DOCUMENT_IDS = ['signed_policy', 'general_conditions', 'premium_receipt'] as const;
export type PolicyDocumentId = typeof DOCUMENT_IDS[number];
export type PolicyDetail = PolicySummary & { exclusions: { code: string; text: string }[]; conditionsVersion: string;
  documents: { documentId: PolicyDocumentId; issuedAt: string }[];
  payments: { date: string; amount: string; currency: 'COP'; status: 'paid' | 'pending' | 'failed'; reference: string | null }[] };
export type PolicyListing = { policies: PolicySummary[]; hasMore: boolean };
export type PolicyFile = { blob: Blob; fileName: string };
export type PolicyOutcome<T> = { kind: 'ok'; value: T } | { kind: 'unauthenticated' | 'notFound' | 'unavailable'; traceId?: string };

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const money = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,14})\.[0-9]{4}$/.test(v);
const RFC_3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const instant = (v: unknown): v is string => typeof v === 'string' && RFC_3339.test(v) && Number.isFinite(Date.parse(v));
const list = <T>(v: unknown, check: (item: unknown) => item is T): v is T[] => Array.isArray(v) && v.every(check);

function coverage(v: unknown): v is PolicyCoverage {
  if (!record(v)) return false;
  if (v.kind === 'mortgage_life') return money(v.sumInsured);
  return v.kind === 'flight_delay' && uuid(v.flightReference) && typeof v.thresholdMinutes === 'number' && Number.isSafeInteger(v.thresholdMinutes) && v.thresholdMinutes >= 1 && money(v.payoutAmount);
}
function summary(v: unknown): v is PolicySummary {
  return record(v) && uuid(v.policyId) && (v.product === 'vida_hipotecario' || v.product === 'flight_delay') && v.status === 'issued' && money(v.premium)
    && v.currency === 'COP' && instant(v.effectiveFrom) && instant(v.effectiveUntil) && coverage(v.coverage);
}
const exclusion = (v: unknown): v is PolicyDetail['exclusions'][number] => record(v) && typeof v.code === 'string' && typeof v.text === 'string';
const documentEntry = (v: unknown): v is PolicyDetail['documents'][number] =>
  record(v) && DOCUMENT_IDS.some(id => id === v.documentId) && instant(v.issuedAt);
const payment = (v: unknown): v is PolicyDetail['payments'][number] => record(v) && instant(v.date) && money(v.amount) && v.currency === 'COP'
  && ['paid', 'pending', 'failed'].includes(String(v.status)) && (v.reference === null || typeof v.reference === 'string');
function detail(v: unknown): v is PolicyDetail {
  return summary(v) && list((v as Record<string, unknown>).exclusions, exclusion) && typeof (v as Record<string, unknown>).conditionsVersion === 'string'
    && list((v as Record<string, unknown>).documents, documentEntry) && list((v as Record<string, unknown>).payments, payment);
}

async function read<T>(path: string, signal: AbortSignal, valid: (body: Record<string, unknown>) => T | null): Promise<PolicyOutcome<T>> {
  try {
    const response = await fetchWithSession(path, { method: 'GET', signal, cache: 'no-store', headers: { accept: 'application/json' } });
    const body: unknown = await response.json();
    const traceId = record(body) && uuid(body.traceId) ? body.traceId : undefined;
    if (response.status === 401) return { kind: 'unauthenticated', traceId };
    if (response.status === 404) return { kind: 'notFound', traceId };
    const value = response.status === 200 && traceId && record(body) ? valid(body) : null;
    return value === null ? { kind: 'unavailable', traceId } : { kind: 'ok', value };
  } catch (error) { if (signal.aborted) throw error; return { kind: 'unavailable' }; }
}

export const listPolicies = (signal: AbortSignal) => read<PolicyListing>('/api/v1/policies/issued', signal,
  body => (list(body.policies, summary) && body.policies.length <= 6 && typeof body.hasMore === 'boolean' ? { policies: body.policies, hasMore: body.hasMore } : null));
export const readPolicyDetail = (policyId: string, signal: AbortSignal) =>
  read<PolicyDetail>(`/api/v1/policies/${encodeURIComponent(policyId)}/detail`, signal, body => (detail(body) ? body : null));

export async function downloadDocument(policyId: string, documentId: PolicyDocumentId): Promise<PolicyOutcome<PolicyFile>> {
  try {
    const response = await fetchWithSession(`/api/v1/policies/${encodeURIComponent(policyId)}/documents/${documentId}`, { method: 'GET', cache: 'no-store', headers: { accept: 'application/pdf' } });
    if (response.status === 401) return { kind: 'unauthenticated' };
    if (response.status === 404) return { kind: 'notFound' };
    if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('application/pdf')) return { kind: 'unavailable' };
    const fileName = /filename="([A-Za-z0-9._-]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? `${documentId}.pdf`;
    return { kind: 'ok', value: { blob: await response.blob(), fileName } };
  } catch { return { kind: 'unavailable' }; }
}
