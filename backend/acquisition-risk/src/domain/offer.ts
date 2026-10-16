import { monthlyPremium, ratePpm, RULE_VERSION } from './quote';
import type { Signal } from './signal';

export const UNDERWRITING_VERSION = 'academic-mortgage-1';
export const OFFER_TTL_MS = 15 * 60 * 1000;
export function offerRequestIdentity(product: 'vida_hipotecario' | 'flight_delay', sourceReference: string): string {
  return JSON.stringify([product, sourceReference]);
}
export type OfferActor = { clientId: string; subjectToken: string };
export type OfferAuthorization = { consentId: string; textVersion: number; expiresAt: string };
export type OfferQuote = { id: string; quoteId: string; amount: number; termMonths: number; ageYears: number; validUntil: string };
export type OfferTerms = {
  offerId: string; offerVersion: 1; quoteId: string | null; clientId: string; subjectToken: string;
  product: 'vida_hipotecario' | 'flight_delay'; premium: string; currency: 'COP';
  coverage: { kind: 'mortgage_life'; sumInsured: string } | { kind: 'flight_delay'; flightReference: string; thresholdMinutes: 180; payoutAmount: '100000.0000' };
  effectiveFrom: string; effectiveUntil: string; expiresAt: string; ruleVersion: string;
  synthetic: true; status: 'definitive';
};
export type OfferCapture = {
  schemaVersion: 1; contractVersion: 'v1'; correlationId: string;
  inputs: { amount: number; termMonths: number; ageYears: number; debtRatioPpm: number; paymentScore: number; adjustmentPpm: number; baseRatePpm: number; baseRuleVersion: string };
  sources: { source: string; capturedAt: string; quality: 'mock'; degraded: false }[];
  consent: { status: 'verified'; id: string; version: number };
  rule: { id: 'mortgage-underwriting'; version: string }; outcome: 'accepted' | 'declined';
};

// This version is an executable academic rule, not an actuarial tariff or a real insurance offer.
export function underwrite(quote: OfferQuote, signals: Signal[], authorization: OfferAuthorization, traceId: string):
  { accepted: true; premium: string; capture: OfferCapture } | { accepted: false; capture: OfferCapture } | null {
  if (!Number.isSafeInteger(quote.amount) || quote.amount < 1 || !Number.isSafeInteger(quote.ageYears) || quote.ageYears < 18 || quote.ageYears > 70
    || !Number.isSafeInteger(quote.termMonths) || quote.termMonths < 12 || quote.termMonths > 240) return null;
  const data = (scope: string) => signals.find(s => s.scope === scope)?.data;
  const finance = data('income_obligations_12m'), history = data('payment_history_score');
  const identity = data('identity_validation'), affiliation = data('affiliation_regime');
  if (!finance || !history || !identity || !affiliation) return null;
  const income = finance.monthlyIncomeCop, debt = finance.monthlyObligationsCop, score = history.score;
  if (typeof income !== 'number' || !Number.isSafeInteger(income) || income <= 0
    || typeof debt !== 'number' || !Number.isSafeInteger(debt) || debt < 0
    || typeof score !== 'number' || !Number.isSafeInteger(score) || score < 0 || score > 1000
    || typeof identity.verified !== 'boolean' || typeof affiliation.active !== 'boolean') return null;
  const debtRatioPpm = Number(BigInt(debt) * 1000000n / BigInt(income));
  if (!Number.isSafeInteger(debtRatioPpm)) return null;
  // Financial boundaries use DECIMAL(19,4): no more than fifteen whole-currency digits.
  const accepted = quote.amount <= 999999999999999 && identity.verified && affiliation.active && score >= 600 && debtRatioPpm <= 500000;
  const adjustmentPpm = score >= 750 && debtRatioPpm <= 300000 ? 900000 : 1000000;
  const capture: OfferCapture = {
    schemaVersion: 1, contractVersion: 'v1', correlationId: traceId,
    inputs: { amount: quote.amount, termMonths: quote.termMonths, ageYears: quote.ageYears, debtRatioPpm, paymentScore: score, adjustmentPpm, baseRatePpm: ratePpm(quote.ageYears), baseRuleVersion: RULE_VERSION },
    sources: signals.map(s => ({ source: `mock:${s.scope}`, capturedAt: s.capturedAt, quality: 'mock', degraded: false })),
    consent: { status: 'verified', id: authorization.consentId, version: authorization.textVersion },
    rule: { id: 'mortgage-underwriting', version: UNDERWRITING_VERSION }, outcome: accepted ? 'accepted' : 'declined'
  };
  if (!accepted) return { accepted: false, capture };
  const premium = (BigInt(monthlyPremium(quote.amount, quote.ageYears)) * BigInt(adjustmentPpm) + 500000n) / 1000000n;
  if (premium < 1n) return null;
  return { accepted: true, premium: `${premium}.0000`, capture };
}

export function offerTerms(quote: OfferQuote, actor: OfferActor, id: string, premium: string, now: Date, consentExpiry: string): OfferTerms {
  return {
    offerId: id, offerVersion: 1, quoteId: quote.quoteId, ...actor,
    product: 'vida_hipotecario', premium, currency: 'COP', coverage: { kind: 'mortgage_life', sumInsured: `${quote.amount}.0000` },
    effectiveFrom: now.toISOString(), effectiveUntil: new Date(now.getTime() + 365 * 86400000).toISOString(),
    expiresAt: new Date(Math.min(now.getTime() + OFFER_TTL_MS, Date.parse(consentExpiry), Date.parse(quote.validUntil))).toISOString(),
    ruleVersion: UNDERWRITING_VERSION, synthetic: true, status: 'definitive'
  };
}
