import type { SignalScope } from '../../domain/signal';

export type ConsentDenial = 'consent_missing' | 'consent_revoked' | 'consent_expired' | 'consent_invalid' | 'invalid_request' | 'unavailable';

export type ConsentCheck =
  | { allowed: true; consentId: string; textVersion: number; expiresAt: string }
  | { allowed: false; reason: ConsentDenial };

// Identity owns consent. The answer is valid only for the call that asked: it is never stored or reused.
export interface ConsentGuard {
  verify(subjectToken: string, scope: SignalScope): Promise<ConsentCheck>;
}
