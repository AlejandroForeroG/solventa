import type { IdentitySessions, Principal, VerifiedIdentity } from './authentication';
import type { AdvisorPermission, AdvisorPermissions } from './advisor-access';
import type { PartnerQuota } from './partner-quota';

export type ClaimsOperation = 'claims:read' | 'claims:decide';
export type ReportOperation = 'reports:generate' | 'reports:read' | 'reports:download' | 'reports:send';
export type ApiOperation = 'policies:manage-delegated' | 'partner-portal:read' | 'underwriting-decisions:read' | ClaimsOperation | ReportOperation | 'assistance-providers:read' | 'assistance-requests:create' | 'assistance-requests:read' | 'quotes:create' | 'consents:read' | 'consents:write' | 'offers:create' | 'offers:create-flight' | 'offers:read' | 'offers:accept' | 'policies:read' | 'policies:issue' | 'policies:manage' | 'identity-verifications:read' | 'identity-verifications:write' | 'notification-preferences:read' | 'notification-preferences:write' | 'partner-authorizations:read' | 'partner-authorizations:write' | 'partner-offers:create' | 'claims:report' | 'advisor-sale-authorizations:read' | 'advisor-sale-authorizations:write' | 'claims:respond' | 'notices:read' | 'notices:receipt' | 'notices:read-device' | 'notices:receipt-device';
export type PartnerIdentity = { issuer: string; applicationId: string; organizationId: string; scopes: string[] };
export type PartnerCredential = { partnerId: string; credentialId: string; scopes: string[] };
export interface PartnerAccessRepository {
  find(provider: string, reference: string): Promise<PartnerCredential | null>;
}
export type PartnerActor = { kind: 'partner'; partnerId: string; credentialId: string; scopes: ApiOperation[] };
export type PartnerPortalGrant = { quota?: PartnerQuota; expiresAt: string; partnerId: string; code: string; credentials: { id: string; scopes: string[]; expiresAt: string; status: 'active' | 'expired' | 'revoked' }[]; hasMoreCredentials: boolean };
export interface PartnerPortalPermissions { find(principal: Principal, identity: VerifiedIdentity): Promise<PartnerPortalGrant | null>; }
export type UserActor = { advisorPermission?: AdvisorPermission; partnerPortal?: PartnerPortalGrant; kind: 'user'; channel: 'web' | 'mobile'; principal: Principal; operations: ApiOperation[]; authorizationExpiresAt?: string; noticeDestination?: string };
export interface MobileNoticeDestinations {
  find(principal: Principal, identity: VerifiedIdentity): Promise<string | null>;
}
export type AccessActor = PartnerActor | UserActor;
export type AccessDecision<Actor extends AccessActor = AccessActor> = { allowed: true; actor: Actor } | {
  allowed: false;
  error: 'unauthorized' | 'forbidden' | 'access_unavailable' | 'invalid_request';
  status: 400 | 401 | 403 | 503;
};

const workspaceOperations = [
  ['claims', 'claims:read'],
  ['reports', 'reports:read'],
  ['audit', 'underwriting-decisions:read'],
  ['advisor', 'policies:manage-delegated'],
  ['partner', 'partner-portal:read'],
] as const satisfies readonly (readonly [string, ApiOperation])[];
type Workspace = typeof workspaceOperations[number][0];

type WebGrant = { expiresAt: string; advisorPermission?: AdvisorPermission; partnerPortal?: PartnerPortalGrant };

const operations: readonly ApiOperation[] = ['policies:manage-delegated', 'partner-portal:read', 'underwriting-decisions:read', 'claims:read', 'claims:decide', 'reports:generate', 'reports:read', 'reports:download', 'reports:send', 'assistance-providers:read', 'assistance-requests:create', 'assistance-requests:read', 'quotes:create', 'consents:read', 'consents:write', 'offers:create', 'offers:create-flight', 'offers:read', 'offers:accept', 'policies:read', 'policies:issue', 'policies:manage', 'identity-verifications:read', 'identity-verifications:write', 'notification-preferences:read', 'notification-preferences:write', 'partner-authorizations:read', 'partner-authorizations:write', 'partner-offers:create', 'claims:report', 'claims:respond', 'notices:read', 'notices:receipt', 'notices:read-device', 'notices:receipt-device', 'advisor-sale-authorizations:read', 'advisor-sale-authorizations:write'];
// Consent is the customer's own decision: a partner credential never reads, grants or revokes it.
const partnerOperations: readonly ApiOperation[] = ['quotes:create', 'partner-offers:create'];
const webUserOperations: readonly ApiOperation[] = operations.filter(operation => !operation.startsWith('identity-verifications:') && !operation.startsWith('notification-preferences:') && operation !== 'partner-offers:create' && operation !== 'claims:report' && !operation.startsWith('notices:'));
// A native customer reads their own policies but cannot buy, accept or issue: those financial steps stay web-only.
const mobileUserOperations: readonly ApiOperation[] = ['quotes:create', 'policies:read', 'assistance-providers:read', 'assistance-requests:create', 'assistance-requests:read', 'identity-verifications:read', 'identity-verifications:write', 'notification-preferences:read', 'notification-preferences:write', 'claims:report', 'notices:read', 'notices:receipt', 'notices:read-device', 'notices:receipt-device'];
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
function isReportOperation(value: ApiOperation): value is ReportOperation {
  return value === 'reports:generate' || value === 'reports:read' || value === 'reports:download' || value === 'reports:send';
}

// Identities reach this application only after cryptographic verification by an adapter.
export interface AuditPermissions {
  find(principal: Principal, identity: VerifiedIdentity): Promise<{ expiresAt: string } | null>;
}
export interface ClaimsPermissions {
  find(principal: Principal, identity: VerifiedIdentity, operation: ClaimsOperation): Promise<{ expiresAt: string } | null>;
}

export interface ReportPermissions {
  find(principal: Principal, identity: VerifiedIdentity, operation: ReportOperation): Promise<{ expiresAt: string } | null>;
}

export class ApiAccess {
  constructor(private readonly repository: PartnerAccessRepository, private readonly sessions: IdentitySessions, private readonly auditPermissions?: AuditPermissions,
    private readonly claimsPermissions?: ClaimsPermissions, private readonly portalPermissions?: PartnerPortalPermissions, private readonly advisorPermissions?: AdvisorPermissions, private readonly reportPermissions?: ReportPermissions, private readonly noticeDestinations?: MobileNoticeDestinations) {}

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
      const grant = await this.webGrant(principal, identity, operation);
      if (grant === null) return forbidden;
      if (grant) {
        if (!this.isCurrentGrant(grant)) return unavailable;
        const { expiresAt, ...details } = grant;
        return { allowed: true, actor: { kind: 'user', channel: 'web', principal, operations: [operation], authorizationExpiresAt: expiresAt, ...details } };
      }
      return { allowed: true, actor: { kind: 'user', channel: 'web', principal, operations: [operation] } };
    } catch { return unavailable; }
  }
  async webWorkspaces(principal: Principal, identity: VerifiedIdentity): Promise<Workspace[]> {
    const results = await Promise.allSettled(workspaceOperations.map(async ([workspace, operation]) => {
      const grant = await this.webGrant(principal, identity, operation);
      return grant && this.isCurrentGrant(grant) ? workspace : null;
    }));
    return results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
  }

  private isCurrentGrant(grant: WebGrant): boolean {
    const expiry = Date.parse(grant.expiresAt);
    const now = Date.now();
    return expiry > now && expiry <= now + 5500;
  }

  private async webGrant(principal: Principal, identity: VerifiedIdentity, operation: ApiOperation): Promise<WebGrant | null | undefined> {
    if (operation === 'policies:manage-delegated') {
      const advisorPermission = await this.advisorPermissions?.find(principal, identity);
      return advisorPermission ? { expiresAt: advisorPermission.expiresAt, advisorPermission } : null;
    }
    if (operation === 'partner-portal:read') {
      const partnerPortal = await this.portalPermissions?.find(principal, identity);
      return partnerPortal ? { expiresAt: partnerPortal.expiresAt, partnerPortal } : null;
    }
    if (operation === 'underwriting-decisions:read') return await this.auditPermissions?.find(principal, identity) ?? null;
    if (isReportOperation(operation)) return await this.reportPermissions?.find(principal, identity, operation) ?? null;
    if (isClaimsOperation(operation)) return await this.claimsPermissions?.find(principal, identity, operation) ?? null;
    return undefined;
  }

  async mobileUser(identity: VerifiedIdentity, operation: string): Promise<AccessDecision<UserActor>> {
    if (!isApiOperation(operation)) return invalid;
    if (!mobileUserOperations.includes(operation)) return forbidden;
    if (!identity.emailVerified || !identity.providerSubject || !identity.sessionReference) return unauthorized;
    try {
      const principal = await this.sessions.find(identity);
      if (!principal) return unauthorized;
      if (operation === 'notices:read-device' || operation === 'notices:receipt-device') {
        if (!this.noticeDestinations) return unavailable;
        const destination = await this.noticeDestinations.find(principal, identity);
        if (destination === null) return forbidden;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(destination)) return unavailable;
        return { allowed: true, actor: { kind: 'user', channel: 'mobile', principal, operations: [operation], noticeDestination: destination.toLowerCase() } };
      }
      return { allowed: true, actor: { kind: 'user', channel: 'mobile', principal, operations: [operation] } };
    } catch { return unavailable; }
  }
}
