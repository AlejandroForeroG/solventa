import type { AdvisorSaleAuthorization } from '../../domain/advisor-sale-authorization';
import type { Principal } from '../authentication';

export type RevokeAdvisorSaleResult =
  | { kind: 'revoked' | 'already_revoked' | 'expired'; authorization: AdvisorSaleAuthorization }
  | { kind: 'not_found' };

export interface AdvisorSaleAuthorizationStore {
  // Null when no current advisor has that reference, or the advisor is the customer; 'limit_reached' when the customer already has the most active authorizations.
  grant(input: { principal: Principal; advisorReference: string; grantedAt: Date; expiresAt: Date; traceId: string }): Promise<AdvisorSaleAuthorization | null | 'limit_reached'>;
  list(principal: Principal, limit: number): Promise<AdvisorSaleAuthorization[]>;
  revoke(principal: Principal, authorizationId: string, now: Date, traceId: string): Promise<RevokeAdvisorSaleResult>;
  // The customer behind an authorization held by this exact advisor, only while it is usable.
  find(advisorReference: string, authorizationId: string): Promise<{ clientId: string; subjectToken: string; expiresAt: string } | null>;
}
