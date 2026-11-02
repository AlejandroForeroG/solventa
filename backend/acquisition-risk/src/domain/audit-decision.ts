import { reconstructMortgageDecision } from './reconstruct-mortgage-decision';

export type AuditSummary = { decisionId: string; decidedAt: string; outcome: string; ruleVersion: string; contractVersion: string; correlationId: string; quoteId: string | null; product: string | null };
export type AuditRevision = { offerId: string; version: number; premium: string; currency: string; coverage: unknown; validFrom: string; expiresAt: string };
export type HistoricalDecision = AuditSummary & { snapshot: unknown; revisions: AuditRevision[] };
export type AuditSource = { source: string; capturedAt: string; quality: string; degraded: boolean; confidence?: number; failure?: string; substitute?: string };
export type AuditDetail = AuditSummary & {
  inputs: Record<string, string | number | boolean>;
  sources: AuditSource[];
  consent: { status: string; id?: string; version?: number } | null;
  rule: { id: string; version: string } | null;
  model: { status: 'not_used' | 'recorded' | 'unknown'; id?: string; version?: string };
  reconstruction: { status: string; missing: string[]; calculatedPremium?: string; checks?: Record<string, boolean> };
  revisions: (Omit<AuditRevision, 'coverage'> & { flightReference?: string })[];
};
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
const primitive = (v: unknown): v is string | number | boolean => typeof v === 'boolean' || (typeof v === 'number' && Number.isSafeInteger(v)) || text(v);
const inputKeys = ['amount', 'termMonths', 'ageYears', 'monthlyIncomeCop', 'monthlyObligationsCop', 'paymentScore', 'identityVerified', 'affiliationActive', 'debtRatioPpm', 'adjustmentPpm', 'baseRatePpm', 'baseRuleVersion', 'premium', 'payoutAmount', 'thresholdMinutes', 'flightReference', 'scheduleAvailable'];

// Historical lookup exposes only the retained decision contract, never arbitrary stored JSON.
export function explainDecision(decision: HistoricalDecision): AuditDetail {
  const { snapshot, revisions, ...summary } = decision;
  const capture = record(snapshot) ? snapshot : {};
  const inputs: AuditDetail['inputs'] = {};
  if (record(capture.inputs)) for (const [key, value] of Object.entries(capture.inputs)) if (inputKeys.includes(key) && primitive(value)) inputs[key] = value;
  const sources: AuditSource[] = [];
  if (Array.isArray(capture.sources) && capture.sources.length <= 20) for (const source of capture.sources) {
    if (!record(source) || !text(source.source) || !text(source.capturedAt) || !Number.isFinite(Date.parse(source.capturedAt)) || !text(source.quality) || typeof source.degraded !== 'boolean') continue;
    const item: AuditSource = { source: source.source, capturedAt: source.capturedAt, quality: source.quality, degraded: source.degraded };
    if (typeof source.confidence === 'number' && Number.isInteger(source.confidence) && source.confidence >= 0 && source.confidence <= 100) item.confidence = source.confidence;
    if (text(source.failure)) item.failure = source.failure;
    if (text(source.substitute)) item.substitute = source.substitute;
    sources.push(item);
  }
  const consent = record(capture.consent) && text(capture.consent.status) ? { status: capture.consent.status,
    ...(text(capture.consent.id) ? { id: capture.consent.id } : {}),
    ...(typeof capture.consent.version === 'number' && Number.isSafeInteger(capture.consent.version) && capture.consent.version > 0 ? { version: capture.consent.version } : {}) } : null;
  const rule = record(capture.rule) && text(capture.rule.id) && text(capture.rule.version) ? { id: capture.rule.id, version: capture.rule.version } : null;
  const model: AuditDetail['model'] = record(capture.model) && text(capture.model.id) && text(capture.model.version)
    ? { status: 'recorded', id: capture.model.id, version: capture.model.version } : { status: 'unknown' };
  let reconstruction: AuditDetail['reconstruction'] = { status: rule ? 'unsupported_rule' : 'invalid_capture', missing: [] };
  if (rule?.id === 'mortgage-underwriting') {
    const result = reconstructMortgageDecision(snapshot);
    reconstruction = result.status === 'reconstructed' ? { status: result.status, missing: [], calculatedPremium: result.calculatedPremium, checks: result.checks }
      : { status: result.status, missing: result.status === 'incomplete_capture' ? result.missing : [] };
    if (rule.version === 'academic-mortgage-1' && capture.model === undefined) model.status = 'not_used';
  } else if (rule?.id === 'flight-underwriting' && rule.version === 'academic-flight-1') {
    if (capture.model === undefined) model.status = 'not_used';
    const missing = ['premium', 'payoutAmount', 'thresholdMinutes', 'flightReference', 'scheduleAvailable'].filter(key => inputs[key] === undefined).map(key => `inputs.${key}`);
    reconstruction = { status: missing.length ? 'incomplete_capture' : capture.model !== undefined ? 'unsupported_model'
      : capture.schemaVersion !== 1 || capture.contractVersion !== 'v1' || consent?.status !== 'not_required' || sources.length !== 1
        || !Array.isArray(capture.sources) || capture.sources.length !== 1 || sources[0].source !== 'mock:flight-schedule' || sources[0].quality !== 'mock' || sources[0].degraded ? 'invalid_capture'
        : typeof inputs.flightReference !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(inputs.flightReference) || typeof inputs.scheduleAvailable !== 'boolean' ? 'invalid_capture'
        : !inputs.scheduleAvailable || inputs.premium !== '10000.0000' || inputs.payoutAmount !== '100000.0000' || inputs.thresholdMinutes !== 180 || capture.outcome !== 'accepted' ? 'inconsistent_capture' : 'reconstructed', missing };
    if (reconstruction.status === 'reconstructed') reconstruction.calculatedPremium = '10000.0000';
  }
  if (reconstruction.status === 'reconstructed' && (capture.outcome !== decision.outcome || rule?.version !== decision.ruleVersion
    || capture.contractVersion !== decision.contractVersion || capture.correlationId !== decision.correlationId
    || revisions.some(revision => revision.premium !== reconstruction.calculatedPremium || revision.currency !== 'COP'))) reconstruction = { status: 'inconsistent_capture', missing: [] };
  return { ...summary, inputs, sources, consent, rule, model, reconstruction,
    revisions: revisions.map(({ coverage, ...revision }) => ({ ...revision, ...(record(coverage) && coverage.kind === 'flight_delay' && typeof coverage.flightReference === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(coverage.flightReference) ? { flightReference: coverage.flightReference } : {}) })) };
}
