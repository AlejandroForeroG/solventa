import type { VerificationEvaluation, VerificationInputs } from '../../domain/identity-verification';

export type VerificationProviderRequest = { evaluationId: string; evidence: VerificationInputs };
export const verificationProviderFailures = ['timeout', 'unavailable', 'invalid_response'] as const;
export type VerificationProviderFailureCode = typeof verificationProviderFailures[number];

export class VerificationProviderFailure extends Error {
  constructor(readonly code: VerificationProviderFailureCode) { super(code); }
}

export interface IdentityVerificationProvider {
  evaluate(input: VerificationProviderRequest): Promise<VerificationEvaluation>;
}
