export const verificationSteps = ['document', 'selfie', 'liveness'] as const;
export type Step = typeof verificationSteps[number];
export type Locale = 'es-CO' | 'en-US';
export type Evidence = { reference: string; sha256: string; corpusVersion: 'synthetic-identity.v1' };
export type Fixture = Evidence & { step: Step; labels: Record<Locale, string>; assetPath: string };
export type Verification = {
  id: string; version: number; status: 'draft' | 'processing' | 'approved' | 'not_verified' | 'review' | 'unavailable' | 'revoked' | 'expired';
  createdAt: string; expiresAt: string;
  consent: { id: string; purpose: 'identity_verification'; textVersion: number; locale: Locale; grantedAt: string;
    expiresAt: string; revokedAt: string | null; status: 'active' | 'revoked' | 'expired' };
  steps: (Evidence & { step: Step })[];
  result: { outcome: 'approved' | 'not_verified' | 'review'; simulated: true; providerVersion: 'synthetic-kyc.v1'; completedAt: string; failedSteps: Step[] } | null;
  assistance: { reference: string; status: 'pending'; requestedAt: string } | null;
  pendingEvaluation: { reference: string; idempotencyKey: string; expectedVersion: number } | null;
  retryAllowed: boolean;
  assistanceAllowed: boolean;
};
export type Terms = { purpose: 'identity_verification'; textVersion: number; locale: Locale; wording: string;
  wordingHash: string; validityHours: 24; corpusVersion: 'synthetic-identity.v1'; simulated: true };
export class VerificationApiFailure extends Error {
  constructor(readonly code: string, readonly uncertain: boolean, readonly traceId?: string, readonly verification?: Verification) {
    super(code);
  }
}
