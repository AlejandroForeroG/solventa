export const verificationSteps = ['document', 'selfie', 'liveness'] as const;
export type VerificationStep = typeof verificationSteps[number];
export type VerificationCheck = 'pass' | 'fail' | 'review';
export type VerificationEvidence = {
  reference: string;
  sha256: string;
  corpusVersion: string;
};
export type VerificationInputs = Record<VerificationStep, VerificationEvidence>;
export type VerificationEvaluation = {
  evaluationId: string;
  providerReference: string;
  providerVersion: string;
  simulated: true;
  completedAt: string;
  checks: Record<VerificationStep, VerificationCheck>;
  screening: 'clear' | 'match' | 'review';
};
export type VerificationOutcome = 'approved' | 'not_verified' | 'review';
export const verificationValidityMs = 24 * 60 * 60 * 1000;
export const verificationPurpose = 'identity_verification';
export const verificationTextVersion = 1;
export const verificationCorpusVersion = 'synthetic-identity.v1';
export type VerificationLocale = 'es-CO' | 'en-US';
export const verificationWording: Record<VerificationLocale, string> = {
  'es-CO': 'Autorizo a Solventa a procesar los archivos sintéticos seleccionados para una verificación KYC/AML simulada. El consentimiento y el avance son válidos por 24 horas para este intento. Puedo revocarlo; al revocar o vencer no se podrán evaluar ni reutilizar los pasos. Solo se conservan referencias, hashes e historial mínimo de auditoría, sin archivos personales ni constancia legal. El resultado no habilita por sí solo la contratación.',
  'en-US': 'I authorize Solventa to process the selected synthetic files for a simulated KYC/AML verification. Consent and progress are valid for 24 hours for this attempt. I may revoke consent; after revocation or expiry, steps cannot be evaluated or reused. Only references, hashes and minimal audit history are retained, without personal files or a legal certificate. The result does not itself grant permission to contract.',
};

export type VerificationStatus = 'draft' | 'processing' | VerificationOutcome | 'unavailable' | 'revoked' | 'expired';
export type VerificationState = {
  id: string;
  clientId: string;
  version: number;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  consentId: string;
  textVersion: number;
  locale: VerificationLocale;
  wordingHash: string;
  evidence: Partial<VerificationInputs>;
  status: VerificationStatus;
  failures: number;
  pending: { evaluationId: string; key: string; expectedVersion: number; startedAt: string; evidence: VerificationInputs } | null;
  result: VerificationEvaluation | null;
  assistance: { reference: string; status: 'pending'; requestedAt: string } | null;
};

export type VerificationErrorCode = 'invalid_request' | 'unauthorized' | 'not_found' | 'conflict' | 'terms_outdated'
  | 'consent_inactive' | 'verification_in_progress' | 'steps_incomplete' | 'evidence_invalid' | 'assistance_unavailable' | 'access_unavailable';
export class VerificationFailure extends Error {
  constructor(readonly code: VerificationErrorCode, readonly status: 400 | 401 | 404 | 409 | 503) { super(code); }
}

export function currentVerificationStatus(state: VerificationState, now: string): VerificationStatus {
  if (state.revokedAt !== null) return 'revoked';
  if (Date.parse(state.expiresAt) <= Date.parse(now)) return 'expired';
  return state.status;
}

export function verificationView(state: VerificationState, now: string) {
  const status = currentVerificationStatus(state, now);
  const active = status !== 'revoked' && status !== 'expired';
  return {
    id: state.id, version: state.version, status, createdAt: state.createdAt, expiresAt: state.expiresAt,
    consent: { id: state.consentId, purpose: verificationPurpose, textVersion: state.textVersion, locale: state.locale,
      grantedAt: state.createdAt, expiresAt: state.expiresAt, revokedAt: state.revokedAt,
      status: active ? 'active' as const : status as 'revoked' | 'expired' },
    steps: active ? verificationSteps.filter(step => state.evidence[step]).map(step => ({ step, ...state.evidence[step]! })) : [],
    result: active && state.result ? { outcome: verificationOutcome(state.result), simulated: true as const,
      providerVersion: state.result.providerVersion, completedAt: state.result.completedAt,
      failedSteps: verificationSteps.filter(step => state.result!.checks[step] !== 'pass') } : null,
    assistance: state.assistance ? { ...state.assistance } : null,
    pendingEvaluation: active && state.pending ? { reference: state.pending.evaluationId, idempotencyKey: state.pending.key, expectedVersion: state.pending.expectedVersion } : null,
    retryAllowed: active && !state.pending && state.status !== 'approved',
    assistanceAllowed: active && !state.pending && state.status !== 'approved' && state.failures > 0 && !state.assistance,
  };
}
export type VerificationView = ReturnType<typeof verificationView>;

// SQL JSONB can reorder object keys; the seal must not depend on their insertion order.
export function canonicalVerificationContent(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item: unknown) => canonicalVerificationContent(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalVerificationContent(record[key])}`).join(',')}}`;
  }
  throw new Error('invalid_verification_state');
}

// This classifies a simulated verification, never a session or a business permission.
export function verificationOutcome(evaluation: VerificationEvaluation): VerificationOutcome {
  if (evaluation.screening !== 'clear' || verificationSteps.some(step => evaluation.checks[step] === 'review')) return 'review';
  return verificationSteps.every(step => evaluation.checks[step] === 'pass') ? 'approved' : 'not_verified';
}

export function retainedVerificationInputs(inputs: VerificationInputs, evaluation: VerificationEvaluation): Partial<VerificationInputs> {
  const retained: Partial<VerificationInputs> = {};
  for (const step of verificationSteps) {
    if (evaluation.checks[step] === 'pass') retained[step] = { ...inputs[step] };
  }
  return retained;
}
