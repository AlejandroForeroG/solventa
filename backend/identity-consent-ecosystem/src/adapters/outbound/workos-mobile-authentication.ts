import { WorkOS } from '@workos-inc/node';
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { VerifiedIdentity } from '../../application/authentication';

const resolvers = new Map<string, JWTVerifyGetKey>();
export class WorkosMobileAuthentication {
  private readonly keys: JWTVerifyGetKey;
  private readonly provider: Pick<WorkOS['userManagement'], 'getUser' | 'revokeSession'>;
  constructor(private readonly config: { clientId: string; apiKey: string }, dependencies?: {
    keys: JWTVerifyGetKey;
    provider: Pick<WorkOS['userManagement'], 'getUser' | 'revokeSession'>;
  }) {
    if (!/^client_[a-zA-Z0-9]+$/.test(config.clientId)) throw new Error('invalid_mobile_client');
    let keys = dependencies?.keys ?? resolvers.get(config.clientId);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(`https://api.workos.com/sso/jwks/${config.clientId}`), {
        timeoutDuration: 1000, cooldownDuration: 30_000, cacheMaxAge: 600_000,
      });
      // Cache public keys only; session revocation and account state remain fresh.
      resolvers.set(config.clientId, keys);
    }
    this.keys = keys;
    this.provider = dependencies?.provider ?? new WorkOS(config.apiKey, {
      clientId: config.clientId, timeout: 2000, maxRetries: 0,
    }).userManagement;
  }
  async authenticate(token: string): Promise<VerifiedIdentity | null> {
    if (token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
    let identity: { providerSubject: string; sessionReference: string };
    try {
      const { payload, protectedHeader } = await jwtVerify(token, this.keys, {
        algorithms: ['RS256'], issuer: `https://api.workos.com/user_management/${this.config.clientId}`, clockTolerance: 0,
        requiredClaims: ['iss', 'sub', 'sid', 'client_id', 'exp', 'iat'],
      });
      if (payload.client_id !== this.config.clientId
        || (payload.aud !== undefined && payload.aud !== this.config.clientId)
        || typeof payload.sub !== 'string' || !/^user_[a-zA-Z0-9]+$/.test(payload.sub)
        || typeof payload.sid !== 'string' || !/^session_[a-zA-Z0-9]+$/.test(payload.sid)
        || typeof payload.iat !== 'number' || !Number.isSafeInteger(payload.iat)
        || typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp)
        || payload.iat < 0 || payload.iat > Math.floor(Date.now() / 1000) || payload.exp <= payload.iat
        || Object.hasOwn(payload, 'act')
        || (protectedHeader.typ !== undefined && !['jwt', 'at+jwt'].includes(protectedHeader.typ.toLowerCase()))) return null;
      identity = { providerSubject: payload.sub, sessionReference: payload.sid };
    } catch (error) {
      if (error instanceof errors.JWTExpired || error instanceof errors.JWTClaimValidationFailed
        || error instanceof errors.JWSInvalid || error instanceof errors.JWTInvalid
        || error instanceof errors.JWSSignatureVerificationFailed || error instanceof errors.JOSEAlgNotAllowed
        || error instanceof errors.JOSENotSupported || error instanceof errors.JWKSNoMatchingKey
        || error instanceof errors.JWKSMultipleMatchingKeys) return null;
      throw new Error('mobile_identity_provider_unavailable', { cause: error });
    }
    let user;
    try { user = await this.provider.getUser(identity.providerSubject); }
    catch (error) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 404) return null;
      throw error;
    }
    if (user.id !== identity.providerSubject || !user.emailVerified) return null;
    return { ...identity, emailVerified: true };
  }
  async revoke(identity: VerifiedIdentity): Promise<void> {
    try { await this.provider.revokeSession({ sessionId: identity.sessionReference }); }
    catch (error) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 404) return;
      throw error;
    }
  }
}
