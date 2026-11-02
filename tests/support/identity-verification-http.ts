import { createHttp } from '../../backend/identity-consent-ecosystem/src/adapters/inbound/http';
import { ApiAccess } from '../../backend/identity-consent-ecosystem/src/application/api-access';
import { MobileSessions } from '../../backend/identity-consent-ecosystem/src/application/mobile-sessions';
import type { VerifiedIdentity } from '../../backend/identity-consent-ecosystem/src/application/authentication';
import type { SecurityDenial } from '../../backend/identity-consent-ecosystem/src/domain/security-decision';
import { unexpectedAuthentication } from './authentication-fakes';
import { verificationIdentity, verificationOther, verificationSetup } from './identity-verification-fakes';

export const verificationBase = '/api/v1/mobile/identity-verifications';
export function verificationHttpSetup() {
  const setup = verificationSetup();
  const denials: { decision: SecurityDenial; traceId?: string }[] = [];
  const flags = { deniedPersistence: false, providerUnavailable: false };
  const find = async (identity: VerifiedIdentity) => {
    const owner = setup.store.users.get(identity.providerSubject);
    return !setup.store.denied && owner?.session === identity.sessionReference ? { clientId: owner.clientId, subjectToken: owner.subjectToken } : null;
  };
  const sessions = { find, open: async () => { throw new Error('unexpected_session_registration'); }, revoke: async () => { throw new Error('unexpected_logout'); } };
  const access = new ApiAccess({ find: async () => null }, sessions);
  const app = createHttp({
    authentication: unexpectedAuthentication, authorizeApiAccess: async () => ({ allowed: false, error: 'forbidden', status: 403 }),
    verifications: setup.application, verificationAccess: (identity, operation) => access.mobileUser(identity, operation),
    mobile: {
      configuration: { clientId: 'client_synthetic', redirectUri: 'solventa://auth/callback' },
      sessions: new MobileSessions({ find, register: async () => { throw new Error('unexpected_registration'); }, revokeOrBlock: async () => { throw new Error('unexpected_logout'); } }),
      provider: { authenticate: async token => {
        if (flags.providerUnavailable) throw new Error('sensitive_provider_exception');
        return token === 'synthetic.jwt.token' ? verificationIdentity : token === 'synthetic.other.token' ? verificationOther : null;
      }, revoke: async () => {} },
    },
    security: { deny: async (decision, traceId) => {
      if (flags.deniedPersistence) throw new Error('synthetic_denial_commit_failed');
      denials.push({ decision, traceId });
    } },
  });
  return { ...setup, get calls() { return setup.calls; }, app, access, denials, flags };
}
