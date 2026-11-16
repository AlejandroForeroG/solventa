import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { JWTPayload } from 'jose';
import { WorkosPartnerAuthentication } from '../../backend/identity-consent-ecosystem/src/adapters/outbound/workos-partner-authentication';

export const ISSUER = 'https://synthetic.authkit.app';
export const AUDIENCE = 'client_solventa';

// Stands in only for the WorkOS Connect issuer: its keys are local, while Identity verifies signature, issuer,
// audience, claims and scopes with the real verifier.
export async function createMockIssuer() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  const provider = new WorkosPartnerAuthentication({ issuer: ISSUER, audience: AUDIENCE },
    createLocalJWKSet({ keys: [{ ...jwk, kid: 'synthetic-key', alg: 'RS256', use: 'sig' }] }));
  const token = (partner: { applicationId: string; organizationId: string }, scope: string[], overrides: JWTPayload = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ iss: ISSUER, aud: AUDIENCE, sub: partner.applicationId, iat: now - 10, exp: now + 300, client_id: partner.applicationId, org_id: partner.organizationId,
      scope: scope.join(' '), jti: crypto.randomUUID(), ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key', typ: 'JWT' }).sign(privateKey);
  };
  return { provider, token };
}
