import type { VerificationEvaluation, VerificationInputs } from '../../domain/identity-verification';
import type { VerificationLocale, VerificationState, VerificationStep } from '../../domain/identity-verification';
import type { Principal, VerifiedIdentity } from '../authentication';

export type VerificationProviderRequest = { evaluationId: string; evidence: VerificationInputs; requestedAt: string };
export const verificationProviderFailures = ['timeout', 'unavailable', 'invalid_response'] as const;
export type VerificationProviderFailureCode = typeof verificationProviderFailures[number];

export class VerificationProviderFailure extends Error {
  constructor(readonly code: VerificationProviderFailureCode) { super(code); }
}

export interface IdentityVerificationProvider {
  evaluate(input: VerificationProviderRequest): Promise<VerificationEvaluation>;
}

export type VerificationAction = 'grant' | 'step' | 'evaluate' | 'assistance' | 'revoke';
export type VerificationCommand = {
  key: string; requestHash: string; action: VerificationAction; caseId: string;
  phase: 'processing' | 'completed'; evaluationId?: string;
};
export type VerificationCapture = {
  schemaVersion: 1; contractVersion: 'v1'; correlationId: string;
  inputs: Record<string, unknown>;
  sources: { source: string; capturedAt: string; quality: string }[];
  consent: { status: 'verified'; id: string; version: number } | { status: 'absent' };
  rule: { id: string; version: string }; outcome: string;
};
export type VerificationContext = {
  principal: Principal; now: string;
  record: VerificationState | null; current: boolean;
  command: VerificationCommand | null;
};
export type VerificationPlan<T> = {
  value: T; record?: VerificationState; command?: VerificationCommand;
  event?: { action: string; capture: VerificationCapture };
};
export type VerificationOperation = {
  identity: VerifiedIdentity; traceId: string; caseId?: string;
  command?: { key: string; requestHash: string; action: VerificationAction };
};
export interface VerificationStore {
  execute<T>(input: VerificationOperation, decide: (context: VerificationContext) => Promise<VerificationPlan<T>>): Promise<T>;
}
export type VerificationFixture = { reference: string; sha256: string; corpusVersion: string; step: VerificationStep; labels: Record<VerificationLocale, string>; assetPath: string };
export interface VerificationCorpus {
  list(): readonly VerificationFixture[];
  accepts(step: VerificationStep, evidence: VerificationInputs[VerificationStep]): boolean;
}
