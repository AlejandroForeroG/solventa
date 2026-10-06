export type VerifiedIdentity = { providerSubject: string; sessionReference: string; emailVerified: boolean };
export type Principal = { clientId: string; subjectToken: string };
export interface IdentitySessions {
  open(identity: VerifiedIdentity): Promise<Principal>;
  find(identity: VerifiedIdentity): Promise<Principal | null>;
  revoke(identity: VerifiedIdentity): Promise<void>;
}

// Only the provider adapter may produce VerifiedIdentity after token validation.
export class Authentication {
  constructor(private readonly sessions: IdentitySessions) {}
  async login(identity: VerifiedIdentity): Promise<Principal> {
    if (!identity.emailVerified || !identity.providerSubject || !identity.sessionReference) throw new Error('identity_unverified');
    return this.sessions.open(identity);
  }
  async principal(identity: VerifiedIdentity): Promise<Principal | null> {
    if (!identity.emailVerified) return null;
    return this.sessions.find(identity);
  }
  async logout(identity: VerifiedIdentity): Promise<void> { await this.sessions.revoke(identity); }
}
