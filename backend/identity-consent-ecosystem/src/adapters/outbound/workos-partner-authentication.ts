import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

export type PartnerTokenIdentity = {
  issuer: string;
  applicationId: string;
  organizationId: string;
  scopes: string[];
};

const publicKeyResolvers = new Map<string, JWTVerifyGetKey>();

function configuredIssuer(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.authkit\.app$/.test(url.hostname)
    || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || value !== url.origin) throw new Error('invalid_partner_issuer');
  return url.origin;
}

function remoteKeys(issuer: string): JWTVerifyGetKey {
  let resolver = publicKeyResolvers.get(issuer);
  if (!resolver) {
    resolver = createRemoteJWKSet(new URL('/oauth2/jwks', issuer), {
      timeoutDuration: 1000, cooldownDuration: 30_000, cacheMaxAge: 600_000,
    });
    // Only provider public keys are cached; partner grants and revocation stay fresh in SQL.
    publicKeyResolvers.set(issuer, resolver);
  }
  return resolver;
}

export class WorkosPartnerAuthentication {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly keys: JWTVerifyGetKey;

  constructor(config: { issuer: string; audience: string }, keys?: JWTVerifyGetKey) {
    this.issuer = configuredIssuer(config.issuer);
    if (!/^client_[a-zA-Z0-9]+$/.test(config.audience) || config.audience.trim() !== config.audience) throw new Error('invalid_partner_audience');
    this.audience = config.audience;
    this.keys = keys ?? remoteKeys(this.issuer);
  }

  async authenticate(token: string): Promise<PartnerTokenIdentity | null> {
    if (!token || token.length > 8192 || token.trim() !== token
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
    try {
      const { payload, protectedHeader } = await jwtVerify(token, this.keys, {
        algorithms: ['RS256'], issuer: this.issuer, audience: this.audience,
        clockTolerance: 0,
        requiredClaims: ['iss', 'aud', 'sub', 'client_id', 'org_id', 'exp', 'iat', 'jti', 'scope'],
      });
      if (protectedHeader.typ !== undefined && (typeof protectedHeader.typ !== 'string'
        || !['jwt', 'at+jwt'].includes(protectedHeader.typ.toLowerCase()))) return null;
      if (typeof payload.client_id !== 'string' || !/^client_[a-zA-Z0-9]+$/.test(payload.client_id)
        || payload.client_id.trim() !== payload.client_id
        || payload.sub !== payload.client_id || Object.hasOwn(payload, 'sid')
        || typeof payload.org_id !== 'string' || !/^org_[a-zA-Z0-9]+$/.test(payload.org_id)
        || payload.org_id.trim() !== payload.org_id
        || typeof payload.jti !== 'string' || !payload.jti || payload.jti.length > 256
        || typeof payload.iat !== 'number' || typeof payload.exp !== 'number'
        || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
        || payload.iat < 0 || payload.iat > Math.floor(Date.now() / 1000) || payload.exp <= payload.iat
        || typeof payload.scope !== 'string'
        || payload.scope.trim() !== payload.scope
        || !/^(?:[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*)?$/.test(payload.scope)) return null;
      return {
        issuer: this.issuer, applicationId: payload.client_id, organizationId: payload.org_id,
        scopes: payload.scope ? [...new Set(payload.scope.split(' '))] : [],
      };
    } catch (error) {
      if (error instanceof errors.JWTExpired || error instanceof errors.JWTClaimValidationFailed
        || error instanceof errors.JWSInvalid || error instanceof errors.JWTInvalid
        || error instanceof errors.JWSSignatureVerificationFailed || error instanceof errors.JOSEAlgNotAllowed
        || error instanceof errors.JOSENotSupported || error instanceof errors.JWKSNoMatchingKey
        // Raised only after a key set was retrieved, when the token header does not select a single key.
        || error instanceof errors.JWKSMultipleMatchingKeys) return null;
      throw new Error('partner_identity_provider_unavailable', { cause: error });
    }
  }
}
