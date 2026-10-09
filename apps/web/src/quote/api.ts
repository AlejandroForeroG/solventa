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
    if (response.status === 201 || response.status === 200) return { kind: 'quote', quote: await response.json() };
    if (response.status === 400) {
      const body = await response.json();
      return Array.isArray(body.errors) && body.errors.length ? { kind: 'validation', errors: body.errors } : { kind: 'unavailable' };
    }
    if (response.status === 401) return { kind: 'unauthenticated' };
    if (response.status === 403) return { kind: 'denied', traceId: response.headers.get('x-trace-id') ?? undefined };
    if (response.status === 409) return { kind: 'conflict' };
  } catch { /* unreadable body: treated as unavailable */ }
  return { kind: 'unavailable' };
}
