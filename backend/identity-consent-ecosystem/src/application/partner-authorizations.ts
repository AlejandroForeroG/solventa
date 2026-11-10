import type { Principal } from './authentication';
import type { PartnerAuthorizationStore } from './ports/partner-authorizations';
import { authorizationStatus, expiryFor, validateGrantRequest, type PartnerAuthorization } from '../domain/partner-authorization';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIST_LIMIT = 50;

export type AuthorizationView = {
  authorizationId: string; partnerCode: string; operation: PartnerAuthorization['operation'];
  grantedAt: string; expiresAt: string; revokedAt: string | null; status: 'active' | 'revoked' | 'expired';
};

// The customer's own decision: only the authenticated web user grants, lists or revokes it.
export class PartnerAuthorizations {
  constructor(private readonly deps: { store: PartnerAuthorizationStore; now(): Date }) {}

  private view(authorization: PartnerAuthorization): AuthorizationView {
    return { authorizationId: authorization.id, partnerCode: authorization.partnerCode, operation: authorization.operation,
      grantedAt: authorization.grantedAt.toISOString(), expiresAt: authorization.expiresAt.toISOString(),
      revokedAt: authorization.revokedAt?.toISOString() ?? null, status: authorizationStatus(authorization, this.deps.now()) };
  }

  async grant(input: { principal: Principal; body: unknown; traceId: string }) {
    const request = validateGrantRequest(input.body);
    if (!request) return { status: 'invalid' as const };
    const grantedAt = this.deps.now();
    const authorization = await this.deps.store.grant({ principal: input.principal, partnerCode: request.partnerCode, grantedAt,
      expiresAt: expiryFor(grantedAt, request.validityDays), traceId: input.traceId });
    return authorization ? { status: 'created' as const, authorization: this.view(authorization) } : { status: 'partner_not_found' as const };
  }

  async list(principal: Principal) {
    const rows = await this.deps.store.list(principal, LIST_LIMIT);
    return { items: rows.map(row => this.view(row)) };
  }

  async revoke(input: { principal: Principal; authorizationId: string; traceId: string }) {
    if (!UUID.test(input.authorizationId)) return { status: 'invalid' as const };
    const result = await this.deps.store.revoke(input.principal, input.authorizationId.toLowerCase(), this.deps.now(), input.traceId);
    if (result.kind === 'not_found') return { status: 'not_found' as const };
    if (result.kind === 'expired') return { status: 'not_active' as const };
    return { status: 'revoked' as const, authorization: this.view(result.authorization) };
  }
}
