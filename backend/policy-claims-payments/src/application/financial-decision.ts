import { FINANCIAL_RULE } from '../domain/financial';
import type { FinancialErrorCode, SignedOfferAcceptanceV1, SignedParametricEventV1 } from '../domain/financial';
import type { Payment, StoredPolicy } from './ports/financial';

export type FinancialAction = 'offer.accepted' | 'premium.requested' | 'premium.declined' | 'premium.confirmed'
  | 'policy.issued' | 'premium.refund_requested' | 'premium.refunded' | 'parametric.accepted' | 'indemnity.confirmed' | 'financial.denied';
export type FinancialSource = { source: string; capturedAt: string; quality: 'synthetic_verified' | 'synthetic_result'; degraded: false;
  operation?: string; result?: string; reference?: string | null; referenceRecognized?: boolean; eventId?: string; occurredAt?: string };
export type FinancialDecisionCapture = { schemaVersion: 1; contractVersion: 'v1'; correlationId: string;
  inputs: Record<string, unknown>; sources: FinancialSource[]; consent: { status: 'not_required' };
  rule: { id: FinancialAction; version: string }; outcome: string };
export type FinancialEvidence = { payment?: Payment; sources?: FinancialSource[];
  event?: { eventId: string; eventType: string; environment: string; occurredAt: string; delayMinutes?: number };
  issuance?: { signedAt: string; documentHash: string };
  trigger?: 'reconciliation';
  refundReason?: 'signature_refused' | 'expired_before_sign' | 'expired_after_sign' | 'expired_during_final_transaction' | 'signature_invalid' | 'existing_refund_intent' };

export function financialDecision(action: Exclude<FinancialAction, 'financial.denied'>, traceId: string, policy: StoredPolicy,
  outcome: string, evaluatedAt: string, evidence: FinancialEvidence = {}): FinancialDecisionCapture {
  const offer = policy.offer, payment = evidence.payment;
  return { schemaVersion: 1, contractVersion: 'v1', correlationId: traceId,
    inputs: { resourceId: policy.id, synthetic: true, evaluatedAt, policyStatus: policy.status, documentHash: policy.documentHash,
      termsHash: policy.termsHash,
      offer: { acceptanceId: offer.acceptanceId, offerId: offer.offerId, offerVersion: offer.offerVersion, product: offer.product,
        premium: offer.premium, currency: offer.currency, coverage: { ...offer.coverage }, effectiveFrom: offer.effectiveFrom,
        effectiveUntil: offer.effectiveUntil, expiresAt: offer.expiresAt, acceptedAt: offer.acceptedAt, ruleVersion: offer.ruleVersion },
      ...(payment ? { payment: { paymentId: payment.id, operation: payment.operation, amount: payment.amount, currency: payment.currency,
        intentKey: payment.key, intentHash: payment.hash, status: payment.status,
        providerReference: payment.providerReference === 'MOCK-' + payment.id ? payment.providerReference : null } } : {}),
      ...(evidence.event ? { event: { ...evidence.event } } : {}), ...(evidence.issuance ? { issuance: { ...evidence.issuance } } : {}),
      ...(evidence.trigger ? { trigger: evidence.trigger } : {}),
      ...(evidence.refundReason ? { refundReason: evidence.refundReason, refundIntent: { policyId: policy.id, action: 'premium.refund_requested' } } : {}) },
    sources: (evidence.sources ?? []).map(source => ({ ...source })), consent: { status: 'not_required' },
    rule: { id: action, version: FINANCIAL_RULE }, outcome };
}

export function financialRejection(id: string, traceId: string, cause: FinancialErrorCode): FinancialDecisionCapture {
  return { schemaVersion: 1, contractVersion: 'v1', correlationId: traceId, inputs: { resourceId: id, synthetic: true }, sources: [],
    consent: { status: 'not_required' }, rule: { id: 'financial.denied', version: FINANCIAL_RULE }, outcome: cause };
}

export function financialEventSource(event: SignedOfferAcceptanceV1 | SignedParametricEventV1, capturedAt: string): FinancialSource {
  return { source: event.eventType === 'offer.accepted' ? 'acquisition.offer-accepted.v1' : 'synthetic-oracle-v1', capturedAt,
    quality: 'synthetic_verified', degraded: false, operation: 'consume', result: 'authenticated', eventId: event.eventId, occurredAt: event.occurredAt };
}

export function gatewaySource(operation: 'lookup' | 'settle' | 'refund', result: { status: string; reference: string | null },
  payment: Payment, capturedAt: string): FinancialSource {
  const recognized = result.reference === 'MOCK-' + payment.id;
  return { source: 'synthetic-gateway-v1', capturedAt, quality: 'synthetic_result', degraded: false, operation, result: result.status,
    reference: recognized ? result.reference : null, referenceRecognized: recognized };
}
