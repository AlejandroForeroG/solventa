import { fetchWithSession } from '../session-fetch';

// Money crosses this boundary as the owners' exact four-decimal strings; the browser never recalculates it.
export type Offer = {
  offerId: string;
  offerVersion: 1;
  quoteId: string;
  premium: string;
  currency: 'COP';
  sumInsured: string;
  effectiveFrom: string;
  effectiveUntil: string;
  expiresAt: string;
  ruleVersion: string;
  traceId: string;
};
export type Acceptance = { acceptanceId: string; offerId: string; acceptedAt: string; traceId: string };
export type PolicyStatus = 'pending' | 'charged' | 'issued' | 'refunding' | 'refunded';
// The policy's single premium charge; a reference exists only once the synthetic provider confirmed it.
export type PremiumPayment = { status: 'pending' | 'confirmed' | 'declined' | 'refunded'; reference: string | null };
export type Policy = {
  policyId: string;
  offerId: string;
  status: PolicyStatus;
  premium: string;
  currency: 'COP';
  effectiveFrom: string;
  effectiveUntil: string;
  document: string;
  documentHash: string;
  payment: PremiumPayment | null;
  replayed: boolean;
  traceId: string;
};

export type FinancialOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'unauthenticated' }
  | { kind: 'consentRequired' }
  | { kind: 'forbidden' }
  | { kind: 'notFound' }
  | { kind: 'rejected'; code: string }
  | { kind: 'unavailable'; traceId?: string };

export const newIdempotencyKey = () => crypto.randomUUID();

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONEY = /^(0|[1-9][0-9]{0,14})\.[0-9]{4}$/;
const HASH = /^[0-9a-f]{64}$/;
const STATUSES: readonly unknown[] = ['pending', 'charged', 'issued', 'refunding', 'refunded'];
const RECEIPT = /^MOCK-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const instant = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

function asOffer(value: unknown, quoteId: string): Offer | null {
  if (!isRecord(value) || !uuid(value.offerId) || value.offerVersion !== 1 || value.quoteId !== quoteId || value.product !== 'vida_hipotecario'
    || typeof value.premium !== 'string' || !MONEY.test(value.premium) || value.currency !== 'COP' || !isRecord(value.coverage)
    || value.coverage.kind !== 'mortgage_life' || typeof value.coverage.sumInsured !== 'string' || !MONEY.test(value.coverage.sumInsured)
    || !instant(value.effectiveFrom) || !instant(value.effectiveUntil) || !instant(value.expiresAt)
    || typeof value.ruleVersion !== 'string' || !/^academic-[a-z0-9-]+$/.test(value.ruleVersion)
    || value.synthetic !== true || value.status !== 'definitive' || !uuid(value.traceId)) return null;
  return { offerId: value.offerId.toLowerCase(), offerVersion: 1, quoteId, premium: value.premium, currency: 'COP', sumInsured: value.coverage.sumInsured,
    effectiveFrom: value.effectiveFrom, effectiveUntil: value.effectiveUntil, expiresAt: value.expiresAt, ruleVersion: value.ruleVersion, traceId: value.traceId };
}

function asAcceptance(value: unknown, offerId: string): Acceptance | null {
  if (!isRecord(value) || !uuid(value.acceptanceId) || typeof value.offerId !== 'string' || value.offerId.toLowerCase() !== offerId
    || !uuid(value.eventId) || !instant(value.acceptedAt) || value.status !== 'pending_issuance' || value.synthetic !== true || !uuid(value.traceId)) return null;
  return { acceptanceId: value.acceptanceId.toLowerCase(), offerId, acceptedAt: value.acceptedAt, traceId: value.traceId };
}

// Absent means the customer has not confirmed issuance yet; a malformed state is rejected rather than guessed.
function asPayment(value: unknown): PremiumPayment | null | undefined {
  if (value === undefined) return null;
  if (!isRecord(value) || Object.keys(value).length !== 2) return undefined;
  const { status, reference } = value;
  if ((status === 'confirmed' || status === 'refunded') && typeof reference === 'string' && RECEIPT.test(reference)) return { status, reference };
  if ((status === 'pending' || status === 'declined') && reference === null) return { status, reference };
  return undefined;
}

function asPolicy(value: unknown, expected: { offerId?: string; policyId?: string }): Policy | null {
  if (!isRecord(value) || !uuid(value.policyId) || !uuid(value.offerId) || !STATUSES.includes(value.status)
    || typeof value.premium !== 'string' || !MONEY.test(value.premium) || value.currency !== 'COP'
    || !instant(value.effectiveFrom) || !instant(value.effectiveUntil) || typeof value.document !== 'string' || value.document.length === 0
    || typeof value.documentHash !== 'string' || !HASH.test(value.documentHash) || value.synthetic !== true || value.providerMode !== 'mock'
    || typeof value.replayed !== 'boolean' || !uuid(value.traceId)) return null;
  const payment = asPayment(value.payment);
  if (payment === undefined) return null;
  const policyId = value.policyId.toLowerCase();
  const offerId = value.offerId.toLowerCase();
  if ((expected.offerId && offerId !== expected.offerId) || (expected.policyId && policyId !== expected.policyId)) return null;
  return { policyId, offerId, status: value.status as PolicyStatus, premium: value.premium, currency: 'COP', effectiveFrom: value.effectiveFrom,
    effectiveUntil: value.effectiveUntil, document: value.document, documentHash: value.documentHash, payment, replayed: value.replayed, traceId: value.traceId };
}

async function send<T>(path: string, init: RequestInit, read: (body: unknown) => T | null, ok: readonly number[]): Promise<FinancialOutcome<T>> {
  let response: Response;
  try {
    response = await fetchWithSession(path, init);
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    return { kind: 'unavailable' };
  }
  const traceId = response.headers.get('x-trace-id') ?? undefined;
  try {
    if (ok.includes(response.status)) {
      const value = read(await response.json());
      return value === null ? { kind: 'unavailable', traceId } : { kind: 'ok', value };
    }
    if (response.status === 401) return { kind: 'unauthenticated' };
    if (response.status === 404) return { kind: 'notFound' };
    if (response.status === 403) return (await response.json())?.error === 'consent_required' ? { kind: 'consentRequired' } : { kind: 'forbidden' };
    if (response.status === 409) {
      const code: unknown = (await response.json())?.error;
      return { kind: 'rejected', code: typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : 'conflict' };
    }
  } catch { /* an unreadable body is treated as unavailable */ }
  return { kind: 'unavailable', traceId };
}

const post = (body: unknown, idempotencyKey: string, signal?: AbortSignal): RequestInit => ({
  method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey }, body: JSON.stringify(body), signal
});

export const createOffer = (quoteId: string, idempotencyKey: string, signal?: AbortSignal) =>
  send(`/api/v1/quotes/${encodeURIComponent(quoteId)}/offers`, post({}, idempotencyKey, signal), body => asOffer(body, quoteId), [200, 201]);

export const acceptOffer = (offerId: string, idempotencyKey: string, signal?: AbortSignal) =>
  send(`/api/v1/offers/${encodeURIComponent(offerId)}/accept`, post({}, idempotencyKey, signal), body => asAcceptance(body, offerId), [200, 202]);

export const policyForAcceptance = (acceptance: Acceptance, signal?: AbortSignal) =>
  send(`/api/v1/policies/by-acceptance/${encodeURIComponent(acceptance.acceptanceId)}/policy`, { signal }, body => asPolicy(body, { offerId: acceptance.offerId }), [200]);

export const issuePolicy = (policy: Pick<Policy, 'policyId' | 'documentHash'>, idempotencyKey: string, signal?: AbortSignal) =>
  send(`/api/v1/policies/${encodeURIComponent(policy.policyId)}/issue`, post({ documentHash: policy.documentHash }, idempotencyKey, signal),
    body => asPolicy(body, { policyId: policy.policyId }), [200]);

export type FinancialApi = {
  createOffer: typeof createOffer;
  acceptOffer: typeof acceptOffer;
  policyForAcceptance: typeof policyForAcceptance;
  issuePolicy: typeof issuePolicy;
};
export const financialApi: FinancialApi = { createOffer, acceptOffer, policyForAcceptance, issuePolicy };
