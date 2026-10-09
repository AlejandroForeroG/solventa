import { Hono } from 'hono';
import { mountAuthentication } from './authentication-http';
import type { AuthenticationCollaborators } from './authentication-http';
import { mountApiAccess } from './api-access-http';
import { mountConsents } from './consents-http';
import type { Consents } from '../../application/consents';
import type { AuthorizeApiAccess } from './api-access-http';

export function createHttp(deps: { authorizeApiAccess: AuthorizeApiAccess; authentication: AuthenticationCollaborators; consents?: Consents }) {
  const app = new Hono<{ Bindings: IdentityEnv }>();
  app.get('/health', (c) => c.json({ service: 'identity-consent-ecosystem', status: 'alive' }));
  mountAuthentication(app, deps.authentication);
  mountApiAccess(app, deps.authorizeApiAccess);
  if (deps.consents) mountConsents(app, { authorizeApiAccess: deps.authorizeApiAccess, consents: deps.consents });
  app.onError((_, c) => c.json({ error: 'service_unavailable' }, 503));
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}
