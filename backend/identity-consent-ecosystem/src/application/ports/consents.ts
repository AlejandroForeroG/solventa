import type { Consent } from '../../domain/consent';
import type { Principal } from '../authentication';

export type NewConsent = Omit<Consent, 'consentCode' | 'revokedAt'> & {
  subjectToken: string;
  idempotencyKey: string;
  requestHash: string;
  year: number;
  traceId: string;
};
export type GrantResult = { kind: 'created' | 'replayed'; consent: Consent } | { kind: 'conflict' };
export type RevokeResult = { kind: 'revoked' | 'already_revoked' | 'not_active'; consent: Consent } | { kind: 'not_found' };

export interface ConsentStore {
  grant(consent: NewConsent): Promise<GrantResult>;
  findGrant(principal: Principal, idempotencyKey: string, requestHash: string): Promise<GrantResult | null>;
  list(principal: Principal, limit: number, now: Date, after?: string): Promise<Consent[]>;
  revoke(principal: Principal, consentCode: string, now: Date, traceId: string): Promise<RevokeResult>;
  decline(principal: Principal, traceId: string): Promise<void>;
  forSubject(subjectToken: string, purposeCode: string, scope: string, now: Date): Promise<Consent[]>;
}

export interface Platform {
  now(): Date;
  newId(): string;
}

export interface Integrity {
  seal(content: string): Promise<string>;
  digest(content: string): Promise<string>;
}
