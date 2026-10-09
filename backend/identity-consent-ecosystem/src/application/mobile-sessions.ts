import type { IdentitySessions, Principal, VerifiedIdentity } from './authentication';

export interface MobileSessionStore extends Pick<IdentitySessions, 'find'> {
  register(identity: VerifiedIdentity): Promise<Principal | null>;
  revokeOrBlock(identity: VerifiedIdentity): Promise<void>;
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
    await this.store.revokeOrBlock(identity);
  }
}
