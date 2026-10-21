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
