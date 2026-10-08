import type { IdentitySessions, Principal, VerifiedIdentity } from './authentication';

export type PartnerIdentity = { issuer: string; applicationId: string; organizationId: string; scopes: string[] };
export type PartnerCredential = { partnerId: string; credentialId: string; scopes: string[] };
export interface PartnerAccessRepository {
  find(provider: string, reference: string): Promise<PartnerCredential | null>;
}
export type AccessActor = PartnerCredential & { kind: 'partner' | 'web'; principal?: Principal };
export type AccessDecision = { allowed: true; actor: AccessActor } | {
  allowed: false;
  error: 'unauthorized' | 'forbidden' | 'access_unavailable' | 'invalid_request';
  status: 400 | 401 | 403 | 503;
};

const supportedScope = 'quotes:create';
const forbidden: AccessDecision = { allowed: false, error: 'forbidden', status: 403 };
const unavailable: AccessDecision = { allowed: false, error: 'access_unavailable', status: 503 };
const unauthorized: AccessDecision = { allowed: false, error: 'unauthorized', status: 401 };
const invalid: AccessDecision = { allowed: false, error: 'invalid_request', status: 400 };

// Identities reach this application only after cryptographic verification by an adapter.
export class ApiAccess {
  constructor(private readonly repository: PartnerAccessRepository, private readonly sessions: IdentitySessions) {}

  async partner(identity: PartnerIdentity, scope: string): Promise<AccessDecision> {
    if (scope !== supportedScope) return invalid;
    if (!identity.issuer || !identity.organizationId || !identity.applicationId) return unauthorized;
    try {
      const reference = JSON.stringify([identity.issuer, identity.organizationId, identity.applicationId]);
      const credential = await this.repository.find('workos-connect', reference);
      if (!credential || !credential.scopes.includes(scope) || !identity.scopes.includes(scope)) return forbidden;
      return { allowed: true, actor: { kind: 'partner', partnerId: credential.partnerId, credentialId: credential.credentialId, scopes: [supportedScope] } };
    } catch { return unavailable; }
  }

  async web(identity: VerifiedIdentity, environment: string, scope: string, channelReference: string): Promise<AccessDecision> {
    if (scope !== supportedScope) return invalid;
    if (!['local', 'dev', 'staging', 'prod'].includes(environment)) return unavailable;
    if (typeof channelReference !== 'string' || !new RegExp(`^${environment}:[a-z0-9][a-z0-9-]{0,63}$`).test(channelReference)) return unavailable;
    if (!identity.emailVerified || !identity.providerSubject || !identity.sessionReference) return unauthorized;
    try {
      const principal = await this.sessions.find(identity);
      if (!principal) return unauthorized;
      const credential = await this.repository.find('solventa-web', channelReference);
      if (!credential || !credential.scopes.includes(scope)) return forbidden;
      return { allowed: true, actor: { kind: 'web', partnerId: credential.partnerId, credentialId: credential.credentialId, scopes: [supportedScope], principal } };
    } catch { return unavailable; }
  }
}
