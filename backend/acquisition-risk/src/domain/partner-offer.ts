import type { OfferCapture, OfferTerms } from './offer';

export type PartnerOfferSignal = { scope: string; quality: string; degraded: boolean; confidence: number; capturedAt: string; failure?: string };

export type PartnerOfferView = {
  offerId: string; quoteId: string | null; status: OfferTerms['status']; contractable: boolean;
  premium: string; currency: 'COP'; coverage: OfferTerms['coverage'];
  validity: { effectiveFrom: string; effectiveUntil: string; expiresAt: string };
  signals: PartnerOfferSignal[];
  explanation: { ratingVersion: string; underwritingVersion: string; baseRatePpm: number; adjustmentPpm: number };
  synthetic: true;
};

// What a partner may learn: the price, its validity and how trustworthy each signal was.
// Raw signal values, the customer's identifiers and the debt ratio stay out of the response.
export function partnerOfferView(terms: OfferTerms, capture: OfferCapture): PartnerOfferView {
  return {
    offerId: terms.offerId, quoteId: terms.quoteId, status: terms.status, contractable: terms.status === 'definitive',
    premium: terms.premium, currency: terms.currency, coverage: terms.coverage,
    validity: { effectiveFrom: terms.effectiveFrom, effectiveUntil: terms.effectiveUntil, expiresAt: terms.expiresAt },
    signals: capture.sources.map(source => ({ scope: source.source.replace(/^(?:signal|mock):/, ''), quality: source.quality, degraded: source.degraded,
      confidence: source.confidence ?? 100, capturedAt: source.capturedAt, ...(source.failure ? { failure: source.failure } : {}) })),
    explanation: { ratingVersion: capture.inputs.baseRuleVersion, underwritingVersion: capture.rule.version,
      baseRatePpm: capture.inputs.baseRatePpm, adjustmentPpm: capture.inputs.adjustmentPpm },
    synthetic: terms.synthetic
  };
}
