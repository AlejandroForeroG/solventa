import { fetchWithSession } from '../session-fetch';

export type MortgageOffer = {
  offerId: string;
  offerVersion: 1;
  quoteId: string;
  product: 'vida_hipotecario';
  premium: string;
  currency: 'COP';
  coverage: { kind: 'mortgage_life'; sumInsured: string };
  effectiveFrom: string;
  effectiveUntil: string;
  expiresAt: string;
  ruleVersion: string;
  synthetic: true;
  status: 'preliminary' | 'definitive';
  traceId: string;
};

export type OfferOutcome =
  | { kind: 'offer'; offer: MortgageOffer }
  | { kind: 'unauthenticated' }
  | { kind: 'consentRequired' }
  | { kind: 'notFound' }
  | { kind: 'conflict' }
  | { kind: 'unavailable' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONEY = /^(0|[1-9][0-9]{0,14})\.[0-9]{4}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => key in value);
const dateTime = (value: unknown): value is string => typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value));

export function isMortgageOffer(value: unknown): value is MortgageOffer {
  if (!record(value) || !record(value.coverage)) return false;
  const coverage = value.coverage;
  return exact(value, ['offerId', 'offerVersion', 'quoteId', 'product', 'premium', 'currency', 'coverage', 'effectiveFrom', 'effectiveUntil', 'expiresAt', 'ruleVersion', 'synthetic', 'status', 'traceId'])
    && exact(coverage, ['kind', 'sumInsured'])
    && typeof value.offerId === 'string' && UUID.test(value.offerId)
    && value.offerVersion === 1
    && typeof value.quoteId === 'string' && /^COT-[0-9]{4}-[0-9]{5}$/.test(value.quoteId)
    && value.product === 'vida_hipotecario'
    && typeof value.premium === 'string' && MONEY.test(value.premium)
    && value.currency === 'COP'
    && coverage.kind === 'mortgage_life' && typeof coverage.sumInsured === 'string' && MONEY.test(coverage.sumInsured)
    && dateTime(value.effectiveFrom) && dateTime(value.effectiveUntil) && dateTime(value.expiresAt)
    && typeof value.ruleVersion === 'string' && /^academic-[a-z0-9-]+$/.test(value.ruleVersion)
    && value.synthetic === true && (value.status === 'preliminary' || value.status === 'definitive')
    && typeof value.traceId === 'string' && UUID.test(value.traceId);
}
export async function createMortgageOffer(quoteId: string, idempotencyKey: string, signal?: AbortSignal): Promise<OfferOutcome> {
  let response: Response;
  try {
    response = await fetchWithSession(`/api/v1/quotes/${encodeURIComponent(quoteId)}/offers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: '{}',
      signal
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    return { kind: 'unavailable' };
  }
  try {
    if (response.status === 200 || response.status === 201) {
      const offer: unknown = await response.json();
      return isMortgageOffer(offer) ? { kind: 'offer', offer } : { kind: 'unavailable' };
    }
    if (response.status === 401) return { kind: 'unauthenticated' };
    if (response.status === 403) return { kind: 'consentRequired' };
    if (response.status === 404) return { kind: 'notFound' };
    if (response.status === 409) return { kind: 'conflict' };
  } catch { /* malformed or unreadable responses are unavailable */ }
  return { kind: 'unavailable' };
}
