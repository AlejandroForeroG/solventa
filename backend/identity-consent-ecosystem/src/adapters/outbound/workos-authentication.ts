import { WorkOS } from '@workos-inc/node';
import type { VerifiedIdentity } from '../../application/authentication';

export type AuthConfiguration = { clientId: string; apiKey: string; cookiePassword: string; origin: string; redirectUri: string; local: boolean };
export class WorkosAuthentication {
  private readonly sdk: WorkOS;
  constructor(private readonly config: AuthConfiguration) {
    this.sdk = new WorkOS(config.apiKey, { clientId: config.clientId,
      issuer: `https://api.workos.com/user_management/${config.clientId}`, timeout: 5000, maxRetries: 0 });
  }
  async begin() {
    return this.sdk.userManagement.getAuthorizationUrlWithPKCE({ provider: 'authkit',
      redirectUri: this.config.redirectUri, clientId: this.config.clientId });
  }
  async exchange(code: string, codeVerifier: string) {
    const result = await this.sdk.userManagement.authenticateWithCode({ code, codeVerifier,
      clientId: this.config.clientId, session: { sealSession: true, cookiePassword: this.config.cookiePassword } });
    if (!result.sealedSession) throw new Error('session_missing');
    const verified = await this.authenticate(result.sealedSession, false);
    if (!verified) throw new Error('session_invalid');
    return { identity: verified.identity, cookie: result.sealedSession };
  }
  async authenticate(cookie: string, refresh = true): Promise<{ identity: VerifiedIdentity; cookie?: string } | null> {
    const session = this.sdk.userManagement.loadSealedSession({ sessionData: cookie, cookiePassword: this.config.cookiePassword });
    const result = await session.authenticate();
    if (result.authenticated) return { identity: { providerSubject: result.user.id,
      sessionReference: result.sessionId, emailVerified: result.user.emailVerified } };
    if (!refresh || result.reason !== 'invalid_jwt') return null;
    const updated = await session.refresh();
    if (!updated.authenticated) {
      if (updated.retryable) throw new Error('provider_unavailable');
      return null;
    }
    if (!updated.sealedSession) return null;
    return { identity: { providerSubject: updated.user.id, sessionReference: updated.sessionId,
      emailVerified: updated.user.emailVerified }, cookie: updated.sealedSession };
  }
  async revoke(identity: VerifiedIdentity) { await this.sdk.userManagement.revokeSession({ sessionId: identity.sessionReference }); }
  logoutUrl(identity: VerifiedIdentity) {
    return this.sdk.userManagement.getLogoutUrl({ sessionId: identity.sessionReference, returnTo: this.config.origin + '/' });
  }
}
