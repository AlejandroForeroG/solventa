export const FINANCIAL_RULE = 'academic-financial-1';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const HEX = /^[0-9a-f]{64}$/;
export type FinancialEnvironment = 'local' | 'dev' | 'staging';
export type FinancialActor = { clientId: string; subjectToken: string };
export type Coverage = { kind: 'mortgage_life'; sumInsured: string } | {
  kind: 'flight_delay'; flightReference: string; thresholdMinutes: number; payoutAmount: string;
};
export type AcceptedOffer = {
  acceptanceId: string; offerId: string; offerVersion: number; clientId: string; subjectToken: string;
  product: 'vida_hipotecario' | 'flight_delay'; premium: string; currency: 'COP'; coverage: Coverage;
  effectiveFrom: string; effectiveUntil: string; expiresAt: string; ruleVersion: string; acceptedAt: string;
};
export type ParametricPayload = { policyId: string; flightReference: string; delayMinutes: number };
export type FinancialEnvelope<T, Kind extends string> = {
  version: 1; eventType: Kind; eventId: string; environment: FinancialEnvironment; synthetic: true;
  occurredAt: string; correlationId: string; payload: T; signature: string;
};
export type SignedOfferAcceptanceV1 = FinancialEnvelope<AcceptedOffer, 'offer.accepted'>;
export type SignedParametricEventV1 = FinancialEnvelope<ParametricPayload, 'flight.delay_verified'>;
export type PolicyStatus = 'pending' | 'charged' | 'issued' | 'refunding' | 'refunded';
export type PolicyView = { policyId: string; offerId: string; offerVersion: number; status: PolicyStatus;
  premium: string; currency: 'COP'; effectiveFrom: string; effectiveUntil: string;
  document: string; documentHash: string; synthetic: true; providerMode: 'mock' };
export type FinancialErrorCode = 'invalid_request' | 'invalid_event' | 'event_conflict' | 'offer_invalid'
  | 'forbidden' | 'not_found' | 'idempotency_conflict' | 'document_mismatch' | 'integrity_violation'
  | 'policy_not_active' | 'event_not_covered' | 'signature_failed' | 'payment_declined' | 'policy_pending';
// The premium's current state for the customer; it is not part of a stored command result.
export type PaymentView = { status: 'pending' | 'confirmed' | 'declined' | 'refunded'; reference: string | null };
export type FinancialResult = { status: 'ok'; replayed: boolean; policy: PolicyView; payment?: PaymentView }
  | { status: 'denied'; error: FinancialErrorCode; httpStatus: 400 | 403 | 404 | 409; traceId: string }
  | { status: 'unavailable'; error: 'financial_unavailable'; httpStatus: 503; traceId: string };
export class InvalidFinancialRecord extends Error {}
export function paymentContent(payment: { id: string; policyId: string; operation: 'premium' | 'indemnity'; key: string; amount: string; currency: 'COP' }): string {
  return JSON.stringify(['payment-intent-v1', payment.id, payment.policyId, payment.operation, payment.key, payment.amount, payment.currency]);
}
export function issuanceTimeContent(policyId: string, documentHash: string, issuedAt: string): string {
  return JSON.stringify(['policy-issued-at-v1', policyId, documentHash, issuedAt]);
}
export function eventWithinIssuedCoverage(occurredAt: string, issuedAt: string, from: string, until: string): boolean {
  return [occurredAt, issuedAt, from, until].every(iso) && Date.parse(occurredAt) >= Date.parse(issuedAt)
    && Date.parse(occurredAt) >= Date.parse(from) && Date.parse(occurredAt) < Date.parse(until);
}

export function money(value: unknown, positive = true): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,14})\.[0-9]{4}$/.test(value)
    && (!positive || BigInt(value.replace('.', '')) > 0n);
}
export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, names: string[]): boolean {
  return Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
export function iso(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}
function validCoverage(value: unknown): value is Coverage {
  if (!object(value)) return false;
  if (value.kind === 'mortgage_life') return keys(value, ['kind', 'sumInsured']) && money(value.sumInsured);
  return value.kind === 'flight_delay' && keys(value, ['kind', 'flightReference', 'thresholdMinutes', 'payoutAmount'])
    && typeof value.flightReference === 'string' && UUID.test(value.flightReference)
    && value.thresholdMinutes === 180 && value.payoutAmount === '100000.0000';
}
export function isAcceptedOffer(value: unknown): value is AcceptedOffer {
  if (!object(value) || !keys(value, ['acceptanceId', 'offerId', 'offerVersion', 'clientId', 'subjectToken', 'product', 'premium', 'currency', 'coverage', 'effectiveFrom', 'effectiveUntil', 'expiresAt', 'ruleVersion', 'acceptedAt'])) return false;
  return ['acceptanceId', 'offerId', 'clientId', 'subjectToken'].every(key => typeof value[key] === 'string' && UUID.test(value[key]))
    && typeof value.offerVersion === 'number' && Number.isSafeInteger(value.offerVersion) && value.offerVersion > 0
    && money(value.premium) && value.currency === 'COP' && validCoverage(value.coverage)
    && ((value.product === 'vida_hipotecario' && value.coverage.kind === 'mortgage_life') || (value.product === 'flight_delay' && value.coverage.kind === 'flight_delay'))
    && iso(value.effectiveFrom) && iso(value.effectiveUntil) && iso(value.expiresAt) && iso(value.acceptedAt)
    && Date.parse(value.effectiveUntil) > Date.parse(value.effectiveFrom)
    && Date.parse(value.acceptedAt) < Date.parse(value.expiresAt)
    && Date.parse(value.acceptedAt) >= Date.parse(value.effectiveFrom) && Date.parse(value.acceptedAt) < Date.parse(value.effectiveUntil)
    && typeof value.ruleVersion === 'string' && /^academic-[a-z0-9-]{1,60}$/.test(value.ruleVersion);
}
function baseEnvelope(value: unknown, environment: FinancialEnvironment, kind: string): value is Record<string, unknown> {
  return object(value) && keys(value, ['version', 'eventType', 'eventId', 'environment', 'synthetic', 'occurredAt', 'correlationId', 'payload', 'signature'])
    && value.version === 1 && value.eventType === kind && value.environment === environment && value.synthetic === true
    && typeof value.eventId === 'string' && UUID.test(value.eventId) && typeof value.correlationId === 'string' && UUID.test(value.correlationId)
    && iso(value.occurredAt) && typeof value.signature === 'string' && HEX.test(value.signature);
}
export function isOfferEnvelope(value: unknown, environment: FinancialEnvironment): value is SignedOfferAcceptanceV1 {
  return baseEnvelope(value, environment, 'offer.accepted') && isAcceptedOffer(value.payload)
    && Date.parse(value.occurredAt as string) >= Date.parse(value.payload.acceptedAt);
}
export function isParametricEnvelope(value: unknown, environment: FinancialEnvironment): value is SignedParametricEventV1 {
  if (!baseEnvelope(value, environment, 'flight.delay_verified') || !object(value.payload)) return false;
  const payload = value.payload;
  return keys(payload, ['policyId', 'flightReference', 'delayMinutes']) && typeof payload.policyId === 'string' && UUID.test(payload.policyId)
    && typeof payload.flightReference === 'string' && UUID.test(payload.flightReference)
    && typeof payload.delayMinutes === 'number' && Number.isSafeInteger(payload.delayMinutes) && payload.delayMinutes >= 0 && payload.delayMinutes <= 10080;
}
export function offerContent(offer: AcceptedOffer): string {
  const coverage = offer.coverage.kind === 'mortgage_life' ? ['mortgage_life', offer.coverage.sumInsured]
    : ['flight_delay', offer.coverage.flightReference, offer.coverage.thresholdMinutes, offer.coverage.payoutAmount];
  return JSON.stringify([offer.acceptanceId, offer.offerId, offer.offerVersion, offer.clientId, offer.subjectToken,
    offer.product, offer.premium, offer.currency, coverage, offer.effectiveFrom, offer.effectiveUntil, offer.expiresAt, offer.ruleVersion, offer.acceptedAt]);
}
export function eventContent(event: SignedOfferAcceptanceV1 | SignedParametricEventV1): string {
  const payload = event.eventType === 'offer.accepted' ? offerContent(event.payload)
    : JSON.stringify([event.payload.policyId, event.payload.flightReference, event.payload.delayMinutes]);
  return JSON.stringify(['financial-event-v1', event.version, event.eventType, event.eventId, event.environment,
    event.synthetic, event.occurredAt, event.correlationId, payload]);
}
export function policyDocument(id: string, offer: AcceptedOffer): string {
  return canonical({ synthetic: true, providerMode: 'mock', ruleVersion: FINANCIAL_RULE, policyId: id,
    offerId: offer.offerId, offerVersion: offer.offerVersion, premium: offer.premium, currency: offer.currency,
    coverage: offer.coverage, effectiveFrom: offer.effectiveFrom, effectiveUntil: offer.effectiveUntil });
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
