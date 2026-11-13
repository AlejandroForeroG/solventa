import { fetchWithSession } from '../session-fetch';
import { CLAIM_STATES, type ClaimState } from './api';

export type CaseAudience = 'case' | 'customer';
export type Expert = { id: string; name: string };
export type CaseRecord = {
  claimNumber: string; policyId: string; state: ClaimState; occurredAt: string; eventType: string | null; place: string | null; description: string | null;
  access: 'assigned' | 'unassigned' | 'customer'; requiredEvidence: number;
  evidence: { id: string; contentType: string; byteSize: number; verifiedAt: string }[];
  requirements: { id: string; details: string; deadline: string; status: 'pending' | 'received'; responseText: string | null; receivedAt: string | null; evidenceIds: string[] }[];
  history: { id: string; action: string; at: string; state: string; reason: string | null; expert: Expert | null; actorId: string | null }[];
  notices: { id: string; action: string; at: string }[];
};
export type OwnedCase = { claimId: string; claimNumber: string; state: ClaimState };
type Outcome<T> = { kind: 'ok'; value: T } | { kind: 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'invalid' | 'unavailable'; traceId?: string };

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nullable = (value: unknown) => value === null || typeof value === 'string';
const state = (value: unknown): value is ClaimState => CLAIM_STATES.some(item => item === value);
const num = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const entries = (value: unknown, predicate: (item: unknown) => boolean) => Array.isArray(value) && value.every(predicate);
const expert = (value: unknown): value is Expert => record(value) && typeof value.id === 'string' && typeof value.name === 'string';

function caseRecord(value: unknown): value is CaseRecord {
  return record(value) && typeof value.claimNumber === 'string' && uuid(value.policyId) && state(value.state) && date(value.occurredAt)
    && nullable(value.eventType) && nullable(value.place) && nullable(value.description)
    && ['assigned', 'unassigned', 'customer'].includes(String(value.access)) && num(value.requiredEvidence)
    && entries(value.evidence, item => record(item) && uuid(item.id) && typeof item.contentType === 'string' && num(item.byteSize) && date(item.verifiedAt))
    && entries(value.requirements, item => record(item) && uuid(item.id) && typeof item.details === 'string' && date(item.deadline)
      && (item.status === 'pending' || item.status === 'received') && nullable(item.responseText)
      && (item.receivedAt === null || date(item.receivedAt)) && entries(item.evidenceIds, uuid))
    && entries(value.history, item => record(item) && uuid(item.id) && typeof item.action === 'string' && date(item.at) && state(item.state)
      && nullable(item.reason) && (item.expert === null || expert(item.expert)) && (item.actorId === null || uuid(item.actorId)))
    && entries(value.notices, item => record(item) && uuid(item.id) && typeof item.action === 'string' && date(item.at));
}

async function request<T>(path: string, init: RequestInit, validate: (value: unknown) => value is T): Promise<Outcome<T>> {
  try {
    const reply = await fetchWithSession('/api/v1/claims' + path, { ...init, cache: 'no-store' });
    const value: unknown = await reply.json();
    const traceId = record(value) && uuid(value.traceId) ? value.traceId : undefined;
    if (reply.ok && traceId && validate(value)) return { kind: 'ok', value };
    const error = ({ 400: 'invalid', 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 422: 'invalid' } as const);
    const kind = error[reply.status as keyof typeof error] ?? 'unavailable';
    return { kind, traceId };
  } catch { return { kind: 'unavailable' }; }
}

export function getCase(id: string, audience: CaseAudience, signal: AbortSignal) {
  return request('/' + id + '/' + audience, { signal }, caseRecord);
}
export function getOwnedCases(signal: AbortSignal) {
  return request('/customer/cases', { signal }, (value): value is { items: OwnedCase[] } => record(value)
    && entries(value.items, item => record(item) && uuid(item.claimId) && typeof item.claimNumber === 'string' && state(item.state)));
}
export function getExperts(signal: AbortSignal) {
  return request('/experts', { signal }, (value): value is { experts: Expert[]; simulated: true } =>
    record(value) && value.simulated === true && entries(value.experts, expert));
}
export function caseCommand(claimId: string, path: string, body: object, key: string) {
  return request('/' + claimId + '/' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body) }, (value): value is { state: ClaimState } =>
    record(value) && state(value.state) && (uuid(value.actionId) || uuid(value.decisionId)) && typeof value.replayed === 'boolean');
}
export async function sendRequirementFile(claimId: string, requirementId: string, fileId: string, file: File) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  const sha256 = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return request('/' + claimId + '/requirements/' + requirementId + '/files/' + fileId,
    { method: 'PUT', headers: { 'content-type': file.type, 'x-content-sha256': sha256 }, body: file },
    (value): value is { fileId: string; state: 'verified' } => record(value) && value.fileId === fileId && value.state === 'verified');
}
