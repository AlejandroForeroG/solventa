import type { PartnerAuthorization } from '../../domain/partner-authorization';
import type { Principal } from '../authentication';

export type RevokeAuthorizationResult =
  | { kind: 'revoked' | 'already_revoked' | 'expired'; authorization: PartnerAuthorization }
  | { kind: 'not_found' };

export interface PartnerAuthorizationStore {
  // Null when no active partner has that code.
  grant(input: { principal: Principal; partnerCode: string; grantedAt: Date; expiresAt: Date; traceId: string }): Promise<PartnerAuthorization | null>;
  list(principal: Principal, limit: number): Promise<PartnerAuthorization[]>;
  revoke(principal: Principal, authorizationId: string, now: Date, traceId: string): Promise<RevokeAuthorizationResult>;
  // The customer behind an authorization held by this exact partner, only while it is usable.
  find(partnerId: string, authorizationId: string): Promise<{ clientId: string; subjectToken: string; expiresAt: string } | null>;
}
