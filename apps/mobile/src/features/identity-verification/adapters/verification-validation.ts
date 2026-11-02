import { identityVerificationFixtures } from '@solventa/contracts';
import { VerificationApiFailure } from '../domain/verification';
import type { Evidence, Fixture, Locale, Step, Terms, Verification } from '../domain/verification';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^[0-9a-f]{64}$/;
const key = /^[\x21-\x7e]{1,128}$/;
export function invalid(): never { throw new VerificationApiFailure('invalid_response', true); }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string { if (typeof value !== 'string') invalid(); return value; }
function date(value: unknown): string { const result = text(value); if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) invalid(); return result; }
function id(value: unknown): string { const result = text(value); if (!uuid.test(result)) invalid(); return result; }
function integer(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid(); return value; }
export function locale(value: unknown): Locale { if (value !== 'es-CO' && value !== 'en-US') invalid(); return value; }
function step(value: unknown): Step { if (value !== 'document' && value !== 'selfie' && value !== 'liveness') invalid(); return value; }
function outcome(value: unknown): 'approved' | 'not_verified' | 'review' { if (value !== 'approved' && value !== 'not_verified' && value !== 'review') invalid(); return value; }
export function trace(value: unknown): string | undefined { return typeof value === 'string' && uuid.test(value) ? value : undefined; }
function evidence(value: Record<string, unknown>, kind: Step): Evidence {
  const fixture = identityVerificationFixtures.find(item => item.reference === value.reference && item.step === kind
    && item.sha256 === value.sha256 && item.corpusVersion === value.corpusVersion);
  if (!fixture) invalid();
  return { reference: fixture.reference, sha256: fixture.sha256, corpusVersion: fixture.corpusVersion };
}
export function fixtures(value: unknown): Fixture[] {
  if (!Array.isArray(value) || value.length !== identityVerificationFixtures.length) invalid();
  const result = value.map(item => {
    const record = object(item); const kind = step(record.step); const input = evidence(record, kind);
    const fixture = identityVerificationFixtures.find(candidate => candidate.reference === input.reference)!;
    const labels = object(record.labels);
    if (record.assetPath !== fixture.assetPath || labels['es-CO'] !== fixture.labels['es-CO'] || labels['en-US'] !== fixture.labels['en-US']) invalid();
    return { ...input, step: kind, labels: { 'es-CO': fixture.labels['es-CO'], 'en-US': fixture.labels['en-US'] }, assetPath: fixture.assetPath };
  });
  if (new Set(result.map(item => item.reference)).size !== result.length) invalid();
  return result;
}
export function terms(value: unknown): Terms {
  const record = object(value);
  if (record.purpose !== 'identity_verification' || record.corpusVersion !== 'synthetic-identity.v1' || record.validityHours !== 24 || record.simulated !== true
    || record.textVersion !== 1 || typeof record.wordingHash !== 'string' || !hash.test(record.wordingHash)) invalid();
  const wording = text(record.wording); if (!wording.length || wording.length > 4000) invalid();
  return { purpose: record.purpose, corpusVersion: record.corpusVersion, validityHours: record.validityHours, simulated: true,
    textVersion: record.textVersion, wordingHash: record.wordingHash, locale: locale(record.locale), wording };
}
export function verification(value: unknown): Verification {
  const record = object(value); const consent = object(record.consent);
  const status = record.status;
  if (status !== 'draft' && status !== 'processing' && status !== 'approved' && status !== 'not_verified' && status !== 'review'
    && status !== 'unavailable' && status !== 'revoked' && status !== 'expired') invalid();
  if (consent.purpose !== 'identity_verification' || (consent.status !== 'active' && consent.status !== 'revoked' && consent.status !== 'expired')
    || typeof record.retryAllowed !== 'boolean' || typeof record.assistanceAllowed !== 'boolean' || !Array.isArray(record.steps)) invalid();
  const steps = record.steps.map(value => { const item = object(value); const kind = step(item.step); return { step: kind, ...evidence(item, kind) }; });
  if (steps.length > 3 || new Set(steps.map(item => item.step)).size !== steps.length) invalid();
  let result: Verification['result'] = null;
  if (record.result !== null) {
    const data = object(record.result);
    if (data.simulated !== true || data.providerVersion !== 'synthetic-kyc.v1' || !Array.isArray(data.failedSteps)) invalid();
    const failedSteps = data.failedSteps.map(step);
    if (new Set(failedSteps).size !== failedSteps.length) invalid();
    result = { outcome: outcome(data.outcome), simulated: true, providerVersion: data.providerVersion, completedAt: date(data.completedAt), failedSteps };
  }
  let assistance: Verification['assistance'] = null;
  if (record.assistance !== null) {
    const data = object(record.assistance); if (data.status !== 'pending') invalid();
    assistance = { reference: id(data.reference), status: data.status, requestedAt: date(data.requestedAt) };
  }
  let pendingEvaluation: Verification['pendingEvaluation'] = null;
  if (record.pendingEvaluation !== null) {
    const data = object(record.pendingEvaluation); const idempotencyKey = text(data.idempotencyKey); if (!key.test(idempotencyKey)) invalid();
    pendingEvaluation = { reference: id(data.reference), idempotencyKey, expectedVersion: integer(data.expectedVersion) };
  }
  const active = consent.status === 'active';
  if ((!active && (steps.length || result || pendingEvaluation || record.retryAllowed || record.assistanceAllowed))
    || (status === 'approved' && (!result || result.outcome !== 'approved' || record.retryAllowed))
    || (status === 'processing') !== Boolean(pendingEvaluation)) invalid();
  return { id: id(record.id), version: integer(record.version), status, createdAt: date(record.createdAt), expiresAt: date(record.expiresAt),
    consent: { id: id(consent.id), purpose: consent.purpose, textVersion: integer(consent.textVersion), locale: locale(consent.locale),
      grantedAt: date(consent.grantedAt), expiresAt: date(consent.expiresAt), revokedAt: consent.revokedAt === null ? null : date(consent.revokedAt), status: consent.status },
    steps, result, assistance, pendingEvaluation, retryAllowed: record.retryAllowed, assistanceAllowed: record.assistanceAllowed };
}
