import { SIGNAL_SCOPES, type SignalScope } from './signal';

export type RetainedRiskProfile = {
  id: string; version: number; scope: string; capturedAt: string; expiresAt: string;
  consentId: string; consentVersion: number; correlationId: string;
  signalScope: string; signalCapturedAt: string; values: unknown;
};
export type InputEvidence = {
  field: string; kind: 'retained_profile' | 'historical_mock' | 'offer_revision';
  reference: string; version: string; capturedAt?: string;
};
type Revision = { offerId: string; version: number; coverage: unknown };
type Capture = Record<string, unknown> & { inputs: Record<string, unknown> };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const instant = (v: unknown): v is string => typeof v === 'string' && v.length <= 128 && Number.isFinite(Date.parse(v));
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const legacyKeys = ['amount', 'termMonths', 'ageYears', 'debtRatioPpm', 'paymentScore', 'adjustmentPpm', 'baseRatePpm', 'baseRuleVersion'];
const omittedMortgageKeys = ['monthlyIncomeCop', 'monthlyObligationsCop', 'identityVerified', 'affiliationActive'];
const profileFields = [
  { scope: 'income_obligations_12m', fields: [['monthlyIncomeCop', 'monthlyIncomeCop'], ['monthlyObligationsCop', 'monthlyObligationsCop']] },
  { scope: 'payment_history_score', fields: [['paymentScore', 'score']] },
  { scope: 'identity_validation', fields: [['identityVerified', 'verified']] },
  { scope: 'affiliation_regime', fields: [['affiliationActive', 'active']] }
] as const;

// Frozen responses of the original synthetic provider, not the current provider.
// Source: 689304a8458ee32e112fd52497488c7ce1170c73, mock-risk-signals.ts
// Git blob: 9efc46a9ba67444a78474d2b112fc99f0da29f07. The legacy producer
// identified this fixed contract by mock:<scope> and academic-mortgage-1.
const legacyMock = Object.freeze({
  revision: '689304a8458ee32e112fd52497488c7ce1170c73',
  mortgage: Object.freeze({ monthlyIncomeCop: 8000000, monthlyObligationsCop: 1800000, identityVerified: true, affiliationActive: true }),
  scheduleAvailable: true
});

function captureOf(snapshot: unknown): Capture | null {
  return record(snapshot) && record(snapshot.inputs) && snapshot.schemaVersion === 1 && snapshot.contractVersion === 'v1'
    && uuid(snapshot.correlationId) && record(snapshot.rule) && snapshot.model === undefined ? { ...snapshot, inputs: snapshot.inputs } : null;
}
function sourcesOf(capture: Capture, decidedAt: string): Record<string, unknown>[] | null {
  if (!instant(decidedAt) || !Array.isArray(capture.sources) || capture.sources.length > 20) return null;
  const sources: Record<string, unknown>[] = [];
  for (const source of capture.sources) {
    if (!record(source) || !instant(source.capturedAt) || Date.parse(source.capturedAt) > Date.parse(decidedAt)) return null;
    sources.push(source);
  }
  return sources;
}
const sameTime = (a: string, b: unknown) => instant(b) && Date.parse(a) === Date.parse(b);
function profileValueValid(field: string, value: unknown) {
  if (field === 'identityVerified' || field === 'affiliationActive') return typeof value === 'boolean';
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return false;
  return field === 'monthlyIncomeCop' ? value > 0 : field === 'paymentScore' ? value >= 0 && value <= 1000 : value >= 0;
}

export function retainedProfileRequest(snapshot: unknown, decidedAt: string): { consentId: string; consentVersion: number; scopes: SignalScope[]; capturedAt: string[] } | null {
  const capture = captureOf(snapshot);
  if (!capture || !record(capture.rule) || capture.rule.id !== 'mortgage-underwriting' || capture.rule.version !== 'academic-mortgage-1'
    || !profileFields.some(item => item.fields.some(([field]) => capture.inputs[field] === undefined))
    || !record(capture.consent) || capture.consent.status !== 'verified' || typeof capture.consent.id !== 'string'
    || !capture.consent.id.length || capture.consent.id.length > 128 || !positive(capture.consent.version)) return null;
  const sources = sourcesOf(capture, decidedAt);
  if (!sources || sources.length !== SIGNAL_SCOPES.length) return null;
  const scopes: SignalScope[] = [], capturedAt: string[] = [];
  for (const source of sources) {
    const scope = SIGNAL_SCOPES.find(scope => source.source === `signal:${scope}`);
    if (!scope || scopes.includes(scope) || !instant(source.capturedAt)
      || !((source.quality === 'live' && source.degraded === false) || (source.quality === 'stored_copy' && source.degraded === true && source.substitute === 'stored_copy'))) return null;
    scopes.push(scope); capturedAt.push(source.capturedAt);
  }
  return { consentId: capture.consent.id, consentVersion: capture.consent.version, scopes, capturedAt };
}

export function recoverUnderwritingInputs(snapshot: unknown, profiles: RetainedRiskProfile[], revisions: Revision[], decidedAt: string): { snapshot: unknown; evidence: InputEvidence[]; conflict: boolean } {
  const capture = captureOf(snapshot);
  if (!capture || !record(capture.rule)) return { snapshot, evidence: [], conflict: false };
  const sources = sourcesOf(capture, decidedAt);
  if (!sources) return { snapshot, evidence: [], conflict: false };
  const inputs = { ...capture.inputs }, evidence: InputEvidence[] = [];
  const conflict = () => ({ snapshot, evidence: [], conflict: true });
  const request = retainedProfileRequest(snapshot, decidedAt);
  if (request) {
    if (profiles.length > 20) return conflict();
    for (const spec of profileFields) {
      const source = sources.find(source => source.source === `signal:${spec.scope}`);
      if (!source) continue;
      const matches = profiles.filter(profile => profile.scope === spec.scope && profile.signalScope === spec.scope
        && uuid(profile.id) && positive(profile.version) && instant(profile.capturedAt) && instant(profile.signalCapturedAt) && instant(profile.expiresAt)
        && sameTime(profile.capturedAt, source.capturedAt) && sameTime(profile.capturedAt, profile.signalCapturedAt)
        && Date.parse(profile.expiresAt) > Date.parse(profile.capturedAt) && Date.parse(profile.expiresAt) >= Date.parse(decidedAt)
        && (source.quality === 'stored_copy' || profile.correlationId === capture.correlationId)
        && profile.consentId === request.consentId && profile.consentVersion === request.consentVersion && record(profile.values));
      const first = matches.sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version)[0];
      if (!first || !record(first.values)) continue;
      for (const [field, key] of spec.fields) {
        const value = first.values[key];
        if (!profileValueValid(field, value) || matches.some(profile => !record(profile.values) || profile.values[key] !== value)
          || (inputs[field] !== undefined && inputs[field] !== value)) return conflict();
        if (inputs[field] === undefined) {
          inputs[field] = value;
          evidence.push({ field: `inputs.${field}`, kind: 'retained_profile', reference: first.id, version: String(first.version), capturedAt: first.capturedAt });
        }
      }
    }
  } else if (capture.rule.id === 'mortgage-underwriting' && capture.rule.version === 'academic-mortgage-1'
    && omittedMortgageKeys.every(key => inputs[key] === undefined) && Object.keys(inputs).length === legacyKeys.length && legacyKeys.every(key => inputs[key] !== undefined)
    && sources.length === SIGNAL_SCOPES.length && SIGNAL_SCOPES.every(scope => sources.filter(source => source.source === `mock:${scope}`).length === 1)
    && sources.every(source => source.quality === 'mock' && source.degraded === false && Object.keys(source).length === 4)
    && inputs.paymentScore === 780 && inputs.debtRatioPpm === 225000 && inputs.adjustmentPpm === 900000) {
    for (const [field, value] of Object.entries(legacyMock.mortgage)) {
      inputs[field] = value;
      evidence.push({ field: `inputs.${field}`, kind: 'historical_mock', reference: 'legacy-mock-risk-1', version: legacyMock.revision });
    }
  } else if (capture.rule.id === 'flight-underwriting' && capture.rule.version === 'academic-flight-1'
    && inputs.flightReference === undefined && inputs.scheduleAvailable === undefined && Object.keys(inputs).length === 3
    && inputs.premium === '10000.0000' && inputs.payoutAmount === '100000.0000' && inputs.thresholdMinutes === 180
    && sources.length === 1 && sources[0].source === 'mock:flight-schedule' && sources[0].quality === 'mock' && sources[0].degraded === false && Object.keys(sources[0]).length === 4) {
    const flightRevisions = revisions.filter(revision => record(revision.coverage) && revision.coverage.kind === 'flight_delay' && uuid(revision.coverage.flightReference));
    const first = flightRevisions[0];
    if (first && record(first.coverage)) {
      const reference = first.coverage.flightReference;
      if (flightRevisions.length !== revisions.length || flightRevisions.some(revision => !record(revision.coverage)
        || revision.coverage.flightReference !== reference || revision.coverage.thresholdMinutes !== 180 || revision.coverage.payoutAmount !== '100000.0000')) return conflict();
      inputs.flightReference = reference; inputs.scheduleAvailable = legacyMock.scheduleAvailable;
      evidence.push({ field: 'inputs.flightReference', kind: 'offer_revision', reference: first.offerId, version: String(first.version) },
        { field: 'inputs.scheduleAvailable', kind: 'historical_mock', reference: 'legacy-mock-flight-schedule-1', version: legacyMock.revision });
    }
  }
  return { snapshot: evidence.length ? { ...capture, inputs } : snapshot, evidence, conflict: false };
}
