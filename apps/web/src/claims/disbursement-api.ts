import { fetchWithSession } from '../session-fetch';
import { uuid } from './case-api';
import { parseClaimPayment, parseClaimPaymentPage } from '@solventa/contracts';
import type { ClaimPayment, ClaimPaymentPage } from '@solventa/contracts';

export type { ClaimPayment } from '@solventa/contracts';
export type PaymentResult = { kind: 'ok'; payment: ClaimPayment } | { kind: 'missing' | 'unauthenticated' | 'forbidden' | 'conflict' | 'invalid_amount' | 'unavailable' };
type OwnedPaymentResult = { kind: 'ok'; page: ClaimPaymentPage } | { kind: 'unauthenticated' | 'forbidden' | 'unavailable' };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function approvedAmount(value: string): string | null {
  const match = /^(0|[1-9]\d{0,14})(?:[.,](\d{1,4}))?$/.exec(value.trim());
  if (!match) return null;
  const amount = match[1] + '.' + (match[2] ?? '').padEnd(4, '0');
  return /[1-9]/.test(amount) ? amount : null;
}

export async function claimPayment(claimId: string, signal: AbortSignal, amount?: string): Promise<PaymentResult> {
  const abort = new AbortController(); const cancel = () => abort.abort();
  signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) abort.abort();
  const timeout = setTimeout(cancel, 10000);
  try {
    const response = await fetchWithSession('/api/v1/claims/' + claimId + '/disbursement', { signal: abort.signal, cache: 'no-store',
      ...(amount === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount }) }) });
    if (response.status === 401) return { kind: 'unauthenticated' };
    if (response.status === 403) return { kind: 'forbidden' };
    const body: unknown = await response.json();
    const payment = record(body) ? parseClaimPayment(body.payment) : null;
    if (response.ok && record(body) && uuid(body.traceId) && payment
      && (amount === undefined || typeof body.replayed === 'boolean') && (response.status !== 202 || payment.status === 'pending'))
      return { kind: 'ok', payment };
    if (response.status === 404 && record(body) && body.error === 'not_found' && uuid(body.traceId)) return { kind: 'missing' };
    if (response.status === 409) return { kind: record(body) && body.error === 'invalid_amount' ? 'invalid_amount' : 'conflict' };
    return { kind: 'unavailable' };
  } catch { return { kind: 'unavailable' }; }
  finally { clearTimeout(timeout); signal.removeEventListener('abort', cancel); }
}

export async function getOwnClaimPayments(cursor: string | undefined, signal: AbortSignal): Promise<OwnedPaymentResult> {
  const abort = new AbortController(); const cancel = () => abort.abort();
  signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) abort.abort();
  const timeout = setTimeout(cancel, 10000);
  try {
    const response = await fetchWithSession('/api/v1/claims/customer/disbursements' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), { signal: abort.signal, cache: 'no-store' });
    if (response.status === 401) return { kind: 'unauthenticated' };
    if (response.status === 403) return { kind: 'forbidden' };
    const page = response.ok ? parseClaimPaymentPage(await response.json()) : null;
    return page ? { kind: 'ok', page } : { kind: 'unavailable' };
  } catch { return { kind: 'unavailable' }; }
  finally { clearTimeout(timeout); signal.removeEventListener('abort', cancel); }
}
