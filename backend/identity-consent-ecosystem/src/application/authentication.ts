export type VerifiedIdentity = { providerSubject: string; sessionReference: string; emailVerified: boolean; authenticatedAt?: number };
export type Principal = { clientId: string; subjectToken: string };
export interface IdentitySessions {
  open(identity: VerifiedIdentity): Promise<Principal>;
  find(identity: VerifiedIdentity): Promise<Principal | null>;
  revoke(identity: VerifiedIdentity, correlationId?: string): Promise<void>;
}
export interface LoginSessions extends Pick<IdentitySessions, 'find' | 'revoke'> {
  register(identity: VerifiedIdentity): Promise<Principal | null>;
}

// Only the provider adapter may produce VerifiedIdentity after token validation.
export class Authentication {
  constructor(private readonly sessions: LoginSessions) {}
  async login(identity: VerifiedIdentity): Promise<Principal> {
    if (!identity.emailVerified || !identity.providerSubject || !identity.sessionReference) throw new Error('identity_unverified');
    const principal = await this.sessions.register(identity);
    if (!principal) throw new Error('session_invalid');
    return principal;
  }
  async principal(identity: VerifiedIdentity): Promise<Principal | null> {
    if (!identity.emailVerified) return null;
    return this.sessions.find(identity);
  }
  async logout(identity: VerifiedIdentity, correlationId?: string): Promise<void> { await this.sessions.revoke(identity, correlationId); }
}
