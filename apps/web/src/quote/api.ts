import type { Locale } from '../i18n/messages';

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

export function toRequestBody(values: QuoteValues) {
  return {
    product: 'vida_hipotecario',
    customer: { fullName: values.fullName.trim(), documentType: 'CC', documentNumber: values.documentNumber.trim(), birthDate: values.birthDate, city: values.city.trim() },
    // The partner credit reference is assigned by the channel, never typed by the customer.
    credit: { partnerCreditId: `WEB-${Date.now().toString(36).toUpperCase()}`, amount: Number(values.amount), termMonths: Number(values.termMonths) }
  };
}

export async function requestQuote(values: QuoteValues, idempotencyKey: string, locale: Locale, signal?: AbortSignal): Promise<QuoteOutcome> {
  const post = () => fetch('/api/v1/me/quotes', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'accept-language': locale },
    body: JSON.stringify(toRequestBody(values)),
    signal
  });
  let response: Response;
  try {
    response = await post();
    if (response.status === 401) {
      // The quote never renews the cookie: /auth/session does, and the quote is retried once.
      const renewed = await fetch('/auth/session', { credentials: 'same-origin', signal }).then(r => r.ok, () => false);
      if (renewed) response = await post();
    }
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
