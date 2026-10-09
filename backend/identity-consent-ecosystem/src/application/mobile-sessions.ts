import type { IdentitySessions, Principal, VerifiedIdentity } from './authentication';

export interface MobileSessionStore extends Pick<IdentitySessions, 'find' | 'revoke'> {
  register(identity: VerifiedIdentity): Promise<Principal | null>;
}

export class MobileSessions {
  constructor(private readonly store: MobileSessionStore) {}
  async register(identity: VerifiedIdentity): Promise<Principal | null> {
    if (!identity.emailVerified || !identity.providerSubject || !identity.sessionReference) return null;
    return this.store.register(identity);
  }
  async find(identity: VerifiedIdentity): Promise<Principal | null> {
    if (!identity.emailVerified || !identity.providerSubject || !identity.sessionReference) return null;
    return this.store.find(identity);
  }
  async revoke(identity: VerifiedIdentity): Promise<void> {
    // A pending bootstrap must also leave a revoked reference, so its token cannot register afterward.
    await this.store.register(identity);
    await this.store.revoke(identity);
  }
}
