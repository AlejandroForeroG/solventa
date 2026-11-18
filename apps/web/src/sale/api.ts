import { fetchWithSession } from '../session-fetch';

export type SaleAuthorization = { authorizationId: string; advisorReference: string; operation: 'advisor-sale:prepare'; grantedAt: string; expiresAt: string; revokedAt: string | null; status: 'active' | 'revoked' | 'expired' };
export type PreparedOffer = { offerId: string; quoteId: string; status: 'preliminary' | 'definitive'; contractable: boolean; premium: string; currency: 'COP'; expiresAt: string };
export type PrepareRequest = {
  authorizationId: string;
  customer: { fullName: string; documentType: string; documentNumber: string; birthDate: string; city: string };
  credit: { partnerCreditId: string; amount: number; termMonths: number };
};
export type Outcome<T> = { kind: 'ok'; value: T } | { kind: 'unauthenticated' | 'forbidden' | 'notFound' | 'invalid' | 'consentRequired' | 'conflict' | 'unavailable' };

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const instant = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
const money = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,14})\.[0-9]{4}$/.test(v);

function asAuthorization(v: unknown): SaleAuthorization | null {
  if (!record(v) || !uuid(v.authorizationId) || !uuid(v.advisorReference) || v.operation !== 'advisor-sale:prepare' || !instant(v.grantedAt) || !instant(v.expiresAt)
    || (v.revokedAt !== null && !instant(v.revokedAt)) || (v.status !== 'active' && v.status !== 'revoked' && v.status !== 'expired')
    || (v.status === 'revoked') !== (v.revokedAt !== null)) return null;
  return { authorizationId: v.authorizationId.toLowerCase(), advisorReference: v.advisorReference.toLowerCase(), operation: 'advisor-sale:prepare', grantedAt: v.grantedAt, expiresAt: v.expiresAt, revokedAt: v.revokedAt, status: v.status };
}

function asPreparedOffer(v: unknown): PreparedOffer | null {
  if (!record(v) || !uuid(v.offerId) || typeof v.quoteId !== 'string' || !/^COT-\d{4}-\d{5}$/.test(v.quoteId) || (v.status !== 'preliminary' && v.status !== 'definitive')
    || typeof v.contractable !== 'boolean' || v.contractable !== (v.status === 'definitive') || !money(v.premium) || v.currency !== 'COP' || !record(v.validity) || !instant(v.validity.expiresAt)
    || v.synthetic !== true || !uuid(v.traceId)) return null;
  return { offerId: v.offerId.toLowerCase(), quoteId: v.quoteId, status: v.status, contractable: v.contractable, premium: v.premium, currency: 'COP', expiresAt: v.validity.expiresAt };
}

async function send<T>(path: string, init: RequestInit, read: (body: unknown) => T | null, ok: readonly number[]): Promise<Outcome<T>> {
  let response: Response;
  try { response = await fetchWithSession(path, { cache: 'no-store', ...init }); }
  catch (error) { if ((error as Error).name === 'AbortError') throw error; return { kind: 'unavailable' }; }
  try {
    if (ok.includes(response.status)) {
      const value = read(await response.json());
      return value === null ? { kind: 'unavailable' } : { kind: 'ok', value };
    }
    if (response.status === 401) return { kind: 'unauthenticated' };
    if (response.status === 404) return { kind: 'notFound' };
    if (response.status === 400) return { kind: 'invalid' };
    if (response.status === 403) { const body: unknown = await response.json(); return record(body) && body.error === 'consent_required' ? { kind: 'consentRequired' } : { kind: 'forbidden' }; }
    if (response.status === 409) return { kind: 'conflict' };
  } catch { /* an unreadable body is treated as unavailable */ }
  return { kind: 'unavailable' };
}

const json = (body: unknown, extra: Record<string, string> = {}): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });

export const listSaleAuthorizations = (signal?: AbortSignal) => send('/api/v1/me/advisor-sale-authorizations', { method: 'GET', signal }, body => {
  if (!record(body) || !Array.isArray(body.items) || body.items.length > 50) return null;
  const items = body.items.map(asAuthorization);
  return items.every((item): item is SaleAuthorization => item !== null) ? items : null;
}, [200]);

export const grantSaleAuthorization = (input: { advisorReference: string; validityDays: number }) =>
  send('/api/v1/me/advisor-sale-authorizations', json(input), body => asAuthorization(body), [201]);

export const revokeSaleAuthorization = (authorizationId: string) =>
  send(`/api/v1/me/advisor-sale-authorizations/${encodeURIComponent(authorizationId)}/revoke`, { method: 'POST' },
    body => { const item = asAuthorization(body); return item && item.authorizationId === authorizationId.toLowerCase() && item.status === 'revoked' ? item : null; }, [200]);

export const prepareAdvisorOffer = (request: PrepareRequest, idempotencyKey: string) =>
  send('/api/v1/advisor/offers', json({ authorizationId: request.authorizationId, product: 'vida_hipotecario', customer: request.customer, credit: request.credit }, { 'idempotency-key': idempotencyKey }),
    body => asPreparedOffer(body), [200, 201]);
