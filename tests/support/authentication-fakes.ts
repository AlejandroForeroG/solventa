import type { AuthenticationCollaborators } from '../../backend/identity-consent-ecosystem/src/adapters/inbound/authentication-http';

const unexpected = (what: string) => async (): Promise<never> => { throw new Error(`unexpected_${what}`); };

// For tests that never reach WorkOS or SQL: any use of these collaborators fails the test.
export const unexpectedAuthentication: AuthenticationCollaborators = {
  provider: () => ({
    begin: unexpected('login'),
    exchange: unexpected('callback'),
    authenticate: unexpected('authentication'),
    revoke: unexpected('revocation'),
    logoutUrl: () => { throw new Error('unexpected_logout_url'); },
  }),
  sessions: () => ({
    find: unexpected('session_lookup'),
    open: unexpected('session_registration'),
    revoke: unexpected('session_revocation'),
  }),
};
