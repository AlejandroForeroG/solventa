import { fetchWithSession } from '../session-fetch';
import { SUPPORTED_TERMS } from './wording';

export type SourceKind = 'open_finance' | 'credit_bureau' | 'open_data';
export type ConsentStatus = 'active' | 'revoked' | 'expired';
export type Terms = {
  purposeCode: string;
  textVersion: number;
  validityDays: number;
  sources: { code: string; scope: string; kind: SourceKind }[];
};
export type Consent = {
  consentId: string;
  status: ConsentStatus;
  sources: string[];
  scopes: string[];
  grantedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  seal: string;
};
export type ConsentPage = { items: Consent[]; nextCursor: string | null };

export type Outcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'unauthenticated' }
  | { kind: 'outdated' }
  | { kind: 'notFound' }
  | { kind: 'conflict' }
  | { kind: 'unavailable' };

export const newIdempotencyKey = () => crypto.randomUUID();

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const SOURCE_KINDS: readonly unknown[] = ['open_finance', 'credit_bureau', 'open_data'];
const STATUSES: readonly unknown[] = ['active', 'revoked', 'expired'];

function asTerms(value: unknown): Terms | null {
  if (!isRecord(value) || typeof value.purposeCode !== 'string' || !Number.isInteger(value.textVersion) || !Number.isInteger(value.validityDays) || !Array.isArray(value.sources) || !value.sources.length) return null;
  const sources = value.sources.filter(isRecord).filter(s => typeof s.code === 'string' && typeof s.scope === 'string' && SOURCE_KINDS.includes(s.kind));
  if (sources.length !== value.sources.length) return null;
  if (value.purposeCode !== SUPPORTED_TERMS.purposeCode || value.textVersion !== SUPPORTED_TERMS.textVersion
    || value.validityDays !== SUPPORTED_TERMS.validityDays || sources.length !== SUPPORTED_TERMS.sources.length
    || new Set(sources.map(s => s.code)).size !== sources.length
    || !sources.every(source => SUPPORTED_TERMS.sources.some(expected => expected.code === source.code
      && expected.scope === source.scope && expected.kind === source.kind))) return null;
  return { purposeCode: value.purposeCode, textVersion: value.textVersion as number, validityDays: value.validityDays as number, sources: sources as Terms['sources'] };
}

function asConsent(value: unknown): Consent | null {
  if (!isRecord(value) || typeof value.consentId !== 'string' || !STATUSES.includes(value.status) || !Array.isArray(value.sources) || !value.sources.every(s => typeof s === 'string') || !Array.isArray(value.scopes) || !value.scopes.every(s => typeof s === 'string')
    || typeof value.grantedAt !== 'string' || typeof value.expiresAt !== 'string' || (value.revokedAt !== null && typeof value.revokedAt !== 'string') || typeof value.seal !== 'string') return null;
  return { consentId: value.consentId, status: value.status as ConsentStatus, sources: value.sources as string[], scopes: value.scopes as string[], grantedAt: value.grantedAt, expiresAt: value.expiresAt, revokedAt: value.revokedAt as string | null, seal: value.seal };
}

async function send<T>(path: string, init: RequestInit, read: (response: Response) => Promise<T | null>, ok: readonly number[]): Promise<Outcome<T>> {
  let response: Response;
  try {
    response = await fetchWithSession(path, init);
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    return { kind: 'unavailable' };
  }
  try {
    if (ok.includes(response.status)) {
      const value = await read(response);
      return value === null ? { kind: 'unavailable' } : { kind: 'ok', value };
    }
    if (response.status === 401) return { kind: 'unauthenticated' };
    if (response.status === 404) return { kind: 'notFound' };
    if (response.status === 409) return (await response.json())?.error === 'terms_outdated' ? { kind: 'outdated' } : { kind: 'conflict' };
  } catch { /* an unreadable body is treated as unavailable */ }
  return { kind: 'unavailable' };
}

const post = (body: unknown, headers: Record<string, string>, signal?: AbortSignal): RequestInit => ({
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal
});

export const getTerms = (signal?: AbortSignal) =>
  send('/api/v1/consents/terms', { signal }, async response => asTerms(await response.json()), [200]);

export const grantConsent = (request: { textVersion: number; locale: string; quoteRef?: string }, idempotencyKey: string, signal?: AbortSignal) =>
  send('/api/v1/consents', post(request, { 'idempotency-key': idempotencyKey }, signal), async response => asConsent(await response.json()), [200, 201]);

export const declineConsent = (textVersion: number, signal?: AbortSignal) =>
  send<true>('/api/v1/consents/declines', post({ textVersion }, {}, signal), async () => true, [204]);

export const listConsents = (signal?: AbortSignal, after?: string) =>
  send<ConsentPage>(`/api/v1/consents${after === undefined ? '' : `?after=${encodeURIComponent(after)}`}`, { signal }, async response => {
    const body = await response.json();
    const items = isRecord(body) && Array.isArray(body.items) ? body.items.map(asConsent) : null;
    const nextCursor = isRecord(body) ? body.nextCursor ?? null : null;
    if (nextCursor !== null && (typeof nextCursor !== 'string' || !/^CNS-[0-9]{4}-[0-9]{5,19}$/.test(nextCursor) || nextCursor === after)) return null;
    return items && items.length <= 50 && items.every(item => item !== null)
      ? { items: items as Consent[], nextCursor } : null;
  }, [200]);

export const revokeConsent = (consentId: string, signal?: AbortSignal) =>
  send(`/api/v1/consents/${encodeURIComponent(consentId)}/revoke`, post({}, {}, signal), async response => asConsent(await response.json()), [200]);

export type ConsentApi = {
  getTerms: typeof getTerms;
  grantConsent: typeof grantConsent;
  declineConsent: typeof declineConsent;
  listConsents: typeof listConsents;
  revokeConsent: typeof revokeConsent;
};
export const consentApi: ConsentApi = { getTerms, grantConsent, declineConsent, listConsents, revokeConsent };
