import type { IdentitySessions, Principal, VerifiedIdentity } from './authentication';
import type { AdvisorPermission, AdvisorPermissions } from './advisor-access';
import type { PartnerQuota } from './partner-quota';

export type ClaimsOperation = 'claims:read' | 'claims:decide';
export type ApiOperation = 'policies:manage-delegated' | 'partner-portal:read' | 'underwriting-decisions:read' | ClaimsOperation | 'assistance-providers:read' | 'quotes:create' | 'consents:read' | 'consents:write' | 'offers:create' | 'offers:create-flight' | 'offers:read' | 'offers:accept' | 'policies:read' | 'policies:issue' | 'policies:manage' | 'identity-verifications:read' | 'identity-verifications:write' | 'notification-preferences:read' | 'notification-preferences:write' | 'partner-authorizations:read' | 'partner-authorizations:write' | 'partner-offers:create' | 'claims:report';
export type PartnerIdentity = { issuer: string; applicationId: string; organizationId: string; scopes: string[] };
export type PartnerCredential = { partnerId: string; credentialId: string; scopes: string[] };
export interface PartnerAccessRepository {
  find(provider: string, reference: string): Promise<PartnerCredential | null>;
}
export type PartnerActor = { kind: 'partner'; partnerId: string; credentialId: string; scopes: ApiOperation[] };
export type PartnerPortalGrant = { quota?: PartnerQuota; expiresAt: string; partnerId: string; code: string; credentials: { id: string; scopes: string[]; expiresAt: string; status: 'active' | 'expired' | 'revoked' }[]; hasMoreCredentials: boolean };
export interface PartnerPortalPermissions { find(principal: Principal, identity: VerifiedIdentity): Promise<PartnerPortalGrant | null>; }
export type UserActor = { advisorPermission?: AdvisorPermission; partnerPortal?: PartnerPortalGrant; kind: 'user'; channel: 'web' | 'mobile'; principal: Principal; operations: ApiOperation[]; authorizationExpiresAt?: string };
export type AccessActor = PartnerActor | UserActor;
export type AccessDecision<Actor extends AccessActor = AccessActor> = { allowed: true; actor: Actor } | {
  allowed: false;
  error: 'unauthorized' | 'forbidden' | 'access_unavailable' | 'invalid_request';
  status: 400 | 401 | 403 | 503;
};

const operations: readonly ApiOperation[] = ['policies:manage-delegated', 'partner-portal:read', 'underwriting-decisions:read', 'claims:read', 'claims:decide', 'assistance-providers:read', 'quotes:create', 'consents:read', 'consents:write', 'offers:create', 'offers:create-flight', 'offers:read', 'offers:accept', 'policies:read', 'policies:issue', 'policies:manage', 'identity-verifications:read', 'identity-verifications:write', 'notification-preferences:read', 'notification-preferences:write', 'partner-authorizations:read', 'partner-authorizations:write', 'partner-offers:create', 'claims:report'];
// Consent is the customer's own decision: a partner credential never reads, grants or revokes it.
const partnerOperations: readonly ApiOperation[] = ['quotes:create', 'partner-offers:create'];
const webUserOperations: readonly ApiOperation[] = operations.filter(operation => !operation.startsWith('identity-verifications:') && !operation.startsWith('notification-preferences:') && operation !== 'partner-offers:create' && operation !== 'claims:report');
// A native customer reads their own policies but cannot buy, accept or issue: those financial steps stay web-only.
const mobileUserOperations: readonly ApiOperation[] = ['quotes:create', 'policies:read', 'assistance-providers:read', 'identity-verifications:read', 'identity-verifications:write', 'notification-preferences:read', 'notification-preferences:write', 'claims:report'];
const forbidden = { allowed: false, error: 'forbidden', status: 403 } as const;
const unavailable = { allowed: false, error: 'access_unavailable', status: 503 } as const;
const unauthorized = { allowed: false, error: 'unauthorized', status: 401 } as const;
const invalid = { allowed: false, error: 'invalid_request', status: 400 } as const;

export function isApiOperation(value: unknown): value is ApiOperation {
  return operations.some(operation => operation === value);
}
function isClaimsOperation(value: ApiOperation): value is ClaimsOperation {
  return value === 'claims:read' || value === 'claims:decide';
}

// Identities reach this application only after cryptographic verification by an adapter.
export interface AuditPermissions {
  find(principal: Principal, identity: VerifiedIdentity): Promise<{ expiresAt: string } | null>;
}
export interface ClaimsPermissions {
  find(principal: Principal, identity: VerifiedIdentity, operation: ClaimsOperation): Promise<{ expiresAt: string } | null>;
}

export class ApiAccess {
  constructor(private readonly repository: PartnerAccessRepository, private readonly sessions: IdentitySessions, private readonly auditPermissions?: AuditPermissions,
    private readonly claimsPermissions?: ClaimsPermissions, private readonly portalPermissions?: PartnerPortalPermissions, private readonly advisorPermissions?: AdvisorPermissions) {}

  async partner(identity: PartnerIdentity, operation: string): Promise<AccessDecision<PartnerActor>> {
    if (!isApiOperation(operation)) return invalid;
    if (!partnerOperations.includes(operation)) return forbidden;
    if (!identity.issuer || !identity.organizationId || !identity.applicationId) return unauthorized;
    try {
      const reference = JSON.stringify([identity.issuer, identity.organizationId, identity.applicationId]);
      const credential = await this.repository.find('workos-connect', reference);
      if (!credential || !credential.scopes.includes(operation) || !identity.scopes.includes(operation)) return forbidden;
      return { allowed: true, actor: { kind: 'partner', partnerId: credential.partnerId, credentialId: credential.credentialId, scopes: [operation] } };
    } catch { return unavailable; }
  }

  async webUser(identity: VerifiedIdentity, operation: string): Promise<AccessDecision<UserActor>> {
    if (!isApiOperation(operation)) return invalid;
    if (!webUserOperations.includes(operation)) return forbidden;
    if (!identity.emailVerified || !identity.providerSubject || !identity.sessionReference) return unauthorized;
    try {
      const principal = await this.sessions.find(identity);
      if (!principal) return unauthorized;
      if (operation === 'policies:manage-delegated') {
        const permission = await this.advisorPermissions?.find(principal, identity);
        if (!permission) return forbidden;
        const expiry = Date.parse(permission.expiresAt);
        if (!(expiry > Date.now()) || expiry > Date.now() + 5500) return unavailable;
        return { allowed: true, actor: { kind: 'user', channel: 'web', principal, operations: [operation],
          authorizationExpiresAt: permission.expiresAt, advisorPermission: permission } };
      }
      if (operation === 'partner-portal:read') {
        const grant = await this.portalPermissions?.find(principal, identity);
        if (!grant) return forbidden;
        if (!(Date.parse(grant.expiresAt) > Date.now()) || Date.parse(grant.expiresAt) > Date.now() + 5500) return unavailable;
        return { allowed: true, actor: { kind: 'user', channel: 'web', principal, operations: [operation], authorizationExpiresAt: grant.expiresAt, partnerPortal: grant } };
      }
      if (operation === 'underwriting-decisions:read' || isClaimsOperation(operation)) {
        const grant = await (operation === 'underwriting-decisions:read'
          ? this.auditPermissions?.find(principal, identity)
          : this.claimsPermissions?.find(principal, identity, operation));
        if (!grant) return forbidden;
        if (!(Date.parse(grant.expiresAt) > Date.now()) || Date.parse(grant.expiresAt) > Date.now() + 5500) return unavailable;
        return { allowed: true, actor: { kind: 'user', channel: 'web', principal, operations: [operation], authorizationExpiresAt: grant.expiresAt } };
      }
      return { allowed: true, actor: { kind: 'user', channel: 'web', principal, operations: [operation] } };
    } catch { return unavailable; }
  }
  async mobileUser(identity: VerifiedIdentity, operation: string): Promise<AccessDecision<UserActor>> {
    if (!isApiOperation(operation)) return invalid;
    if (!mobileUserOperations.includes(operation)) return forbidden;
    if (!identity.emailVerified || !identity.providerSubject || !identity.sessionReference) return unauthorized;
    try {
      const principal = await this.sessions.find(identity);
      return principal ? { allowed: true, actor: { kind: 'user', channel: 'mobile', principal, operations: [operation] } } : unauthorized;
    } catch { return unavailable; }
  }
}
