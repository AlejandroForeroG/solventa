import type { Locale } from '../i18n/messages';
import { fetchWithSession } from '../session-fetch';

export type QuoteValues = {
  fullName: string;
  documentNumber: string;
  birthDate: string;
  city: string;
  amount: string;
  termMonths: string;
};

export type Quote = {
  quoteId: string;
  premiumMonthly: number;
  currency: 'COP';
  sumInsured: number;
  termMonths: number;
  validUntil: string;
  basis: 'minimum_data';
  ruleVersion: string;
  traceId: string;
};

export type ServerFieldError = { field: string; code: string; params?: Record<string, number> };

export type QuoteOutcome =
  | { kind: 'quote'; quote: Quote }
  | { kind: 'validation'; errors: ServerFieldError[] }
  | { kind: 'unauthenticated' }
  | { kind: 'denied'; traceId?: string }
  | { kind: 'conflict' }
  | { kind: 'unavailable' };

export const newIdempotencyKey = () => crypto.randomUUID();

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_CODES = ['required', 'invalid_type', 'invalid_format', 'age_out_of_range', 'amount_out_of_range', 'term_out_of_range', 'unsupported_product'];

function isQuote(value: unknown): value is Quote {
  return isRecord(value) && typeof value.quoteId === 'string' && /^COT-[0-9]{4}-[0-9]{5}$/.test(value.quoteId)
    && typeof value.premiumMonthly === 'number' && Number.isSafeInteger(value.premiumMonthly) && value.premiumMonthly >= 0
    && value.currency === 'COP' && typeof value.sumInsured === 'number' && Number.isSafeInteger(value.sumInsured) && value.sumInsured >= 1
    && typeof value.termMonths === 'number' && Number.isInteger(value.termMonths) && value.termMonths >= 12 && value.termMonths <= 240
    && typeof value.validUntil === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.validUntil) && Number.isFinite(Date.parse(value.validUntil))
    && new Date(value.validUntil.slice(0, 10)).toISOString().slice(0, 10) === value.validUntil.slice(0, 10)
    && value.basis === 'minimum_data' && typeof value.ruleVersion === 'string' && value.ruleVersion.length > 0
    && typeof value.traceId === 'string' && UUID.test(value.traceId);
}

function isFieldError(value: unknown): value is ServerFieldError {
  return isRecord(value) && typeof value.field === 'string' && typeof value.code === 'string' && ERROR_CODES.includes(value.code)
    && (value.params === undefined || (isRecord(value.params) && Object.values(value.params).every(param => typeof param === 'number' && Number.isFinite(param))));
}

export function toRequestBody(values: QuoteValues, idempotencyKey: string) {
  return {
    product: 'vida_hipotecario',
    customer: { fullName: values.fullName.trim(), documentType: 'CC', documentNumber: values.documentNumber.trim(), birthDate: values.birthDate, city: values.city.trim() },
    // Derived from the key, so every retry of one attempt sends the same body and can be recognised as a repetition.
    credit: { partnerCreditId: `WEB-${idempotencyKey.replace(/-/g, '').slice(0, 12).toUpperCase()}`, amount: Number(values.amount), termMonths: Number(values.termMonths) }
  };
}

export async function requestQuote(values: QuoteValues, idempotencyKey: string, locale: Locale, signal?: AbortSignal): Promise<QuoteOutcome> {
  let response: Response;
  try {
    response = await fetchWithSession('/api/v1/me/quotes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'accept-language': locale },
      body: JSON.stringify(toRequestBody(values, idempotencyKey)),
      signal
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    return { kind: 'unavailable' };
  }
  try {
    if (response.status === 201 || response.status === 200) {
      const quote: unknown = await response.json();
      return isQuote(quote) ? { kind: 'quote', quote } : { kind: 'unavailable' };
    }
    if (response.status === 400) {
      const body: unknown = await response.json();
      return isRecord(body) && Array.isArray(body.errors) && body.errors.length > 0 && body.errors.every(isFieldError)
        ? { kind: 'validation', errors: body.errors } : { kind: 'unavailable' };
    }
    if (response.status === 401) return { kind: 'unauthenticated' };
    if (response.status === 403) return { kind: 'denied', traceId: response.headers.get('x-trace-id') ?? undefined };
    if (response.status === 409) return { kind: 'conflict' };
  } catch { /* unreadable body: treated as unavailable */ }
  return { kind: 'unavailable' };
}
