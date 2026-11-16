import { fetchWithSession } from '../session-fetch';

export type AuditSummary = { decisionId: string; decidedAt: string; outcome: string; ruleVersion: string; contractVersion: string; correlationId: string; quoteId: string | null; product: string | null };
export type AuditDetail = AuditSummary & {
  inputs: Record<string, string | number | boolean>;
  sources: { source: string; capturedAt: string; quality: string; degraded: boolean; confidence?: number; failure?: string; substitute?: string }[];
  consent: { status: string; id?: string; version?: number } | null;
  rule: { id: string; version: string } | null;
  model: { status: 'not_used' | 'recorded' | 'unknown'; id?: string; version?: string };
  reconstruction: { status: string; missing: string[]; calculatedPremium?: string; checks?: Record<string, boolean> };
  inputEvidence?: { field: string; kind: 'retained_profile' | 'historical_mock' | 'offer_revision'; reference: string; version: string; capturedAt?: string }[];
  revisions: { offerId: string; version: number; premium: string; currency: string; validFrom: string; expiresAt: string; flightReference?: string }[];
};
export type AuditPage = { items: AuditSummary[]; next: string | null };
export type AuditOutcome<T> = { kind: 'ok'; value: T } | { kind: 'unauthenticated' | 'forbidden' | 'notFound' | 'invalid' | 'unavailable'; traceId?: string };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const instant = (v: unknown): v is string => text(v) && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
const money = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,14})\.[0-9]{4}$/.test(v);
function summary(v: unknown): v is AuditSummary & Record<string, unknown> {
  return record(v) && uuid(v.decisionId) && instant(v.decidedAt) && text(v.outcome) && text(v.ruleVersion) && text(v.contractVersion)
    && uuid(v.correlationId) && (v.quoteId === null || (text(v.quoteId) && /^COT-\d{4}-\d{5,19}$/.test(v.quoteId)))
    && (v.product === null || v.product === 'vida_hipotecario' || v.product === 'flight_delay');
}
function detail(v: unknown): v is AuditDetail {
  if (!summary(v) || !record(v)) return false;
  if (!record(v.inputs) || Object.keys(v.inputs).length > 30 || !Object.values(v.inputs).every(x => text(x) || typeof x === 'boolean' || (typeof x === 'number' && Number.isSafeInteger(x)))
    || !Array.isArray(v.sources) || v.sources.length > 20 || !v.sources.every(s => record(s) && text(s.source) && instant(s.capturedAt) && text(s.quality) && typeof s.degraded === 'boolean'
      && (s.confidence === undefined || (typeof s.confidence === 'number' && Number.isInteger(s.confidence) && s.confidence >= 0 && s.confidence <= 100))
      && (s.failure === undefined || text(s.failure)) && (s.substitute === undefined || text(s.substitute)))) return false;
  if (v.consent !== null && (!record(v.consent) || !text(v.consent.status) || (v.consent.id !== undefined && !text(v.consent.id))
    || (v.consent.version !== undefined && !(typeof v.consent.version === 'number' && Number.isSafeInteger(v.consent.version) && v.consent.version > 0)))) return false;
  if (v.rule !== null && (!record(v.rule) || !text(v.rule.id) || !text(v.rule.version))) return false;
  if (!record(v.model) || !['not_used', 'recorded', 'unknown'].includes(String(v.model.status))
    || (v.model.status === 'recorded' && (!text(v.model.id) || !text(v.model.version)))) return false;
  const r = v.reconstruction;
  if (!record(r) || !['reconstructed', 'incomplete_capture', 'invalid_capture', 'unsupported_rule', 'unsupported_model', 'inconsistent_capture'].includes(String(r.status))
    || !Array.isArray(r.missing) || r.missing.length > 30 || !r.missing.every(text)
    || (r.calculatedPremium !== undefined && !money(r.calculatedPremium))
    || (r.checks !== undefined && (!record(r.checks) || Object.keys(r.checks).length > 30 || !Object.values(r.checks).every(x => typeof x === 'boolean')))) return false;
  if (v.inputEvidence !== undefined && (!Array.isArray(v.inputEvidence) || v.inputEvidence.length > 8 || !v.inputEvidence.every(e => record(e)
    && typeof e.field === 'string' && /^inputs\.(monthlyIncomeCop|monthlyObligationsCop|paymentScore|identityVerified|affiliationActive|flightReference|scheduleAvailable)$/.test(e.field)
    && ['retained_profile', 'historical_mock', 'offer_revision'].includes(String(e.kind)) && text(e.reference) && text(e.version)
    && (e.capturedAt === undefined || instant(e.capturedAt))))) return false;
  return Array.isArray(v.revisions) && v.revisions.length <= 100 && v.revisions.every(r => record(r) && uuid(r.offerId) && typeof r.version === 'number'
    && Number.isSafeInteger(r.version) && r.version > 0 && money(r.premium) && typeof r.currency === 'string' && /^[A-Z]{3}$/.test(r.currency) && instant(r.validFrom) && instant(r.expiresAt) && (r.flightReference === undefined || uuid(r.flightReference)));
}
async function read<T>(path: string, signal: AbortSignal, parse: (v: unknown) => T | null): Promise<AuditOutcome<T>> {
  try {
    const response = await fetchWithSession(path, { method: 'GET', signal, cache: 'no-store', headers: { accept: 'application/json' } });
    const body: unknown = await response.json();
    const traceId = record(body) && uuid(body.traceId) ? body.traceId : undefined;
    if (response.status === 401) return { kind: 'unauthenticated', traceId };
    if (response.status === 403) return { kind: 'forbidden', traceId };
    if (response.status === 404) return { kind: 'notFound', traceId };
    if (response.status === 400) return { kind: 'invalid', traceId };
    if (response.status !== 200 || !traceId) return { kind: 'unavailable', traceId };
    const value = parse(body);
    return value ? { kind: 'ok', value } : { kind: 'unavailable', traceId };
  } catch (error) { if (signal.aborted) throw error; return { kind: 'unavailable' }; }
}
export function listAuditDecisions(query: URLSearchParams, signal: AbortSignal) {
  return read<AuditPage>(`/api/v1/underwriting-decisions${query.size ? '?' + query : ''}`, signal, body => record(body) && Array.isArray(body.items)
    && body.items.length <= 20 && body.items.every(summary) && (body.next === null || uuid(body.next)) ? { items: body.items, next: body.next } : null);
}
export function getAuditDecision(id: string, signal: AbortSignal) {
  return read<AuditDetail>(`/api/v1/underwriting-decisions/${encodeURIComponent(id)}`, signal,
    body => record(body) && detail(body.decision) && body.decision.decisionId === id ? body.decision : null);
}
