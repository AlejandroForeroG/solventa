import type { IdentitySessions, Principal, VerifiedIdentity } from './authentication';

export type ApiOperation = 'quotes:create' | 'consents:read' | 'consents:write';
export type PartnerIdentity = { issuer: string; applicationId: string; organizationId: string; scopes: string[] };
export type PartnerCredential = { partnerId: string; credentialId: string; scopes: string[] };
export interface PartnerAccessRepository {
  find(provider: string, reference: string): Promise<PartnerCredential | null>;
}
export type PartnerActor = { kind: 'partner'; partnerId: string; credentialId: string; scopes: ApiOperation[] };
export type UserActor = { kind: 'user'; channel: 'web' | 'mobile'; principal: Principal; operations: ApiOperation[] };
export type AccessActor = PartnerActor | UserActor;
export type AccessDecision<Actor extends AccessActor = AccessActor> = { allowed: true; actor: Actor } | {
  allowed: false;
  error: 'unauthorized' | 'forbidden' | 'access_unavailable' | 'invalid_request';
  status: 400 | 401 | 403 | 503;
};

const operations: readonly ApiOperation[] = ['quotes:create', 'consents:read', 'consents:write'];
// Consent is the customer's own decision: a partner credential never reads, grants or revokes it.
const partnerOperations: readonly ApiOperation[] = ['quotes:create'];
const webUserOperations: readonly ApiOperation[] = ['quotes:create', 'consents:read', 'consents:write'];
const forbidden = { allowed: false, error: 'forbidden', status: 403 } as const;
const unavailable = { allowed: false, error: 'access_unavailable', status: 503 } as const;
const unauthorized = { allowed: false, error: 'unauthorized', status: 401 } as const;
const invalid = { allowed: false, error: 'invalid_request', status: 400 } as const;

export function isApiOperation(value: unknown): value is ApiOperation {
  return operations.some(operation => operation === value);
}

// Identities reach this application only after cryptographic verification by an adapter.
export class ApiAccess {
  constructor(private readonly repository: PartnerAccessRepository, private readonly sessions: IdentitySessions) {}

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
      return { allowed: true, actor: { kind: 'user', channel: 'web', principal, operations: [operation] } };
    } catch { return unavailable; }
  }
  async mobileUser(identity: VerifiedIdentity, operation: string): Promise<AccessDecision<UserActor>> {
    if (!isApiOperation(operation)) return invalid;
    if (operation !== 'quotes:create') return forbidden;
    if (!identity.emailVerified || !identity.providerSubject || !identity.sessionReference) return unauthorized;
    try {
      const principal = await this.sessions.find(identity);
      return principal ? { allowed: true, actor: { kind: 'user', channel: 'mobile', principal, operations: [operation] } } : unauthorized;
    } catch { return unavailable; }
  }
}
