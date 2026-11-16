import { evaluateMortgageV1, type MortgageInputs } from './mortgage-rules';
import type { OfferCapture } from './offer';
import { SIGNAL_SCOPES } from './signal';

type Reconstruction = {
  status: 'reconstructed'; correlationId: string; inputs: MortgageInputs;
  sources: OfferCapture['sources']; consent: OfferCapture['consent'];
  rule: { id: 'mortgage-underwriting'; version: 'academic-mortgage-1' };
  baseRule: { id: 'quote-rating'; version: 'provisional-1' }; model: { status: 'not_used' };
  outcome: OfferCapture['outcome']; calculatedPremium: string; currency: 'COP';
  checks: NonNullable<ReturnType<typeof evaluateMortgageV1>>['checks'];
};
export type MortgageReconstruction = Reconstruction
  | { status: 'incomplete_capture'; missing: string[] }
  | { status: 'invalid_capture' | 'unsupported_rule' | 'unsupported_model' | 'inconsistent_capture' };
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const failures = ['timeout', 'unavailable', 'rate_limited', 'unauthorized', 'not_found', 'invalid_response'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function readSources(value: unknown): OfferCapture['sources'] | null {
  if (!Array.isArray(value) || value.length !== SIGNAL_SCOPES.length) return null;
  const sources: OfferCapture['sources'] = [];
  const scopes = new Set<string>();
  for (const source of value) {
    if (!record(source) || typeof source.source !== 'string' || typeof source.capturedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(source.capturedAt)
      || !Number.isFinite(Date.parse(source.capturedAt)) || Number(source.capturedAt.slice(11, 13)) > 23
      || typeof source.degraded !== 'boolean') return null;
    const day = source.capturedAt.slice(0, 10);
    if (!new Date(`${day}T00:00:00.000Z`).toISOString().startsWith(day)) return null;
    const scope = SIGNAL_SCOPES.find(scope => source.source === `signal:${scope}` || source.source === `mock:${scope}`);
    if (!scope || scopes.has(scope)) return null;
    scopes.add(scope);
    const quality = source.quality;
    if (quality !== 'mock' && quality !== 'live' && quality !== 'stored_copy' && quality !== 'default') return null;
    if (source.confidence !== undefined && (!integer(source.confidence) || source.confidence < 0 || source.confidence > 100)) return null;
    if (source.degraded) {
      if ((quality !== 'stored_copy' && quality !== 'default') || source.substitute !== quality
        || typeof source.failure !== 'string' || !failures.includes(source.failure)) return null;
    } else if ((quality !== 'live' && quality !== 'mock') || source.failure !== undefined || source.substitute !== undefined) return null;
    // Pick only the historical contract; never return arbitrary stored JSON fields.
    const item: OfferCapture['sources'][number] = { source: source.source, capturedAt: source.capturedAt, quality, degraded: source.degraded };
    if (integer(source.confidence)) item.confidence = source.confidence;
    if (source.degraded && (quality === 'stored_copy' || quality === 'default')) {
      item.substitute = quality;
      // Narrow the canonical failure without trusting a stored type assertion.
      const failure = source.failure;
      if (failure === 'timeout' || failure === 'unavailable' || failure === 'rate_limited' || failure === 'unauthorized' || failure === 'not_found' || failure === 'invalid_response') item.failure = failure;
    }
    sources.push(item);
  }
  return sources;
}

// Reconstruct only from the retained artifact and capture. Current source data,
// consent validity, clocks and mutable offer projections cannot explain the past.
export function reconstructMortgageDecision(capture: unknown): MortgageReconstruction {
  if (!record(capture) || capture.schemaVersion !== 1 || capture.contractVersion !== 'v1'
    || typeof capture.correlationId !== 'string' || !uuid.test(capture.correlationId)
    || !record(capture.rule) || !record(capture.inputs)) return { status: 'invalid_capture' };
  if (capture.rule.id !== 'mortgage-underwriting' || capture.rule.version !== 'academic-mortgage-1'
    || capture.inputs.baseRuleVersion !== 'provisional-1') return { status: 'unsupported_rule' };
  // This artifact used a deterministic rule, never a trained model.
  if (capture.model !== undefined) return { status: 'unsupported_model' };
  const input = capture.inputs;
  const required = ['amount', 'termMonths', 'ageYears', 'monthlyIncomeCop', 'monthlyObligationsCop', 'paymentScore', 'identityVerified', 'affiliationActive', 'debtRatioPpm', 'adjustmentPpm', 'baseRatePpm'];
  const missing = required.filter(key => input[key] === undefined).map(key => `inputs.${key}`);
  if (missing.length) return { status: 'incomplete_capture', missing };
  if (!integer(input.amount) || !integer(input.termMonths) || !integer(input.ageYears)
    || !integer(input.monthlyIncomeCop) || !integer(input.monthlyObligationsCop) || !integer(input.paymentScore)
    || typeof input.identityVerified !== 'boolean' || typeof input.affiliationActive !== 'boolean'
    || !integer(input.debtRatioPpm) || !integer(input.adjustmentPpm) || !integer(input.baseRatePpm)) return { status: 'invalid_capture' };
  const sources = readSources(capture.sources);
  const consent = capture.consent;
  if (!sources || !record(consent) || consent.status !== 'verified' || typeof consent.id !== 'string' || !consent.id.length
    || consent.id.length > 128 || !integer(consent.version) || consent.version < 1
    || (capture.outcome !== 'accepted' && capture.outcome !== 'declined' && capture.outcome !== 'preliminary')) return { status: 'invalid_capture' };
  const inputs: MortgageInputs = { amount: input.amount, termMonths: input.termMonths, ageYears: input.ageYears,
    monthlyIncomeCop: input.monthlyIncomeCop, monthlyObligationsCop: input.monthlyObligationsCop,
    paymentScore: input.paymentScore, identityVerified: input.identityVerified, affiliationActive: input.affiliationActive };
  const evaluated = evaluateMortgageV1(inputs);
  if (!evaluated) return { status: 'invalid_capture' };
  const outcome = sources.some(source => source.degraded) ? 'preliminary' : evaluated.accepted ? 'accepted' : 'declined';
  if (outcome !== capture.outcome || evaluated.baseRatePpm !== input.baseRatePpm || evaluated.debtRatioPpm !== input.debtRatioPpm
    || evaluated.adjustmentPpm !== input.adjustmentPpm) return { status: 'inconsistent_capture' };
  return { status: 'reconstructed', correlationId: capture.correlationId, inputs, sources,
    consent: { status: 'verified', id: consent.id, version: consent.version },
    rule: { id: 'mortgage-underwriting', version: 'academic-mortgage-1' }, baseRule: { id: 'quote-rating', version: 'provisional-1' },
    model: { status: 'not_used' }, outcome, calculatedPremium: evaluated.premium, currency: 'COP', checks: evaluated.checks };
}
