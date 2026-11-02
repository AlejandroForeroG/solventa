import type { IdentityVerificationProvider, VerificationProviderRequest } from '../../application/ports/identity-verification';
import { VerificationProviderFailure } from '../../application/ports/identity-verification';
import { verificationSteps } from '../../domain/identity-verification';
import type { VerificationCheck, VerificationEvaluation } from '../../domain/identity-verification';

export const syntheticKycFormat = 'synthetic-kyc.v1';
export type KycSource = (input: VerificationProviderRequest, signal: AbortSignal) => Promise<unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const isCheck = (value: unknown): value is VerificationCheck => value === 'pass' || value === 'fail' || value === 'review';

export function normalizeKycReply(value: unknown, evaluationId: string): VerificationEvaluation {
  if (!uuid.test(evaluationId) || !object(value) || !exactKeys(value, ['formatVersion', 'evaluationId', 'providerReference', 'simulated', 'completedAt', 'checks', 'screening'])
    || value.formatVersion !== syntheticKycFormat || value.evaluationId !== evaluationId
    || typeof value.providerReference !== 'string' || !uuid.test(value.providerReference) || value.simulated !== true
    || typeof value.completedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.completedAt)
    || !Number.isFinite(Date.parse(value.completedAt)) || new Date(value.completedAt).toISOString() !== value.completedAt
    || !object(value.checks) || !exactKeys(value.checks, verificationSteps)
    || !isCheck(value.checks.document) || !isCheck(value.checks.selfie) || !isCheck(value.checks.liveness)
    || (value.screening !== 'clear' && value.screening !== 'match' && value.screening !== 'review')) {
    throw new VerificationProviderFailure('invalid_response');
  }
  return {
    evaluationId, providerReference: value.providerReference, providerVersion: syntheticKycFormat, simulated: true,
    completedAt: value.completedAt,
    checks: { document: value.checks.document, selfie: value.checks.selfie, liveness: value.checks.liveness },
    screening: value.screening,
  };
}

export class KycProvider implements IdentityVerificationProvider {
  constructor(private readonly source: KycSource, private readonly deadlineMs: number) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error('invalid_kyc_deadline');
  }

  async evaluate(input: VerificationProviderRequest): Promise<VerificationEvaluation> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new VerificationProviderFailure('timeout'));
        controller.abort();
      }, this.deadlineMs);
    });
    try {
      const reply = await Promise.race([this.source(input, controller.signal), deadline]);
      return normalizeKycReply(reply, input.evaluationId);
    } catch (error) {
      if (error instanceof VerificationProviderFailure) throw error;
      throw new VerificationProviderFailure('unavailable');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
