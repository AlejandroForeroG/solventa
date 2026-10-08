import { Hono } from 'hono';
import { mountAuthentication } from './authentication-http';
import { mountApiAccess } from './api-access-http';
import type { AuthorizeApiAccess } from './api-access-http';

export function createHttp(deps: { authorizeApiAccess: AuthorizeApiAccess }) {
  const app = new Hono<{ Bindings: IdentityEnv }>();
  app.get('/health', (c) => c.json({ service: 'identity-consent-ecosystem', status: 'alive' }));
  mountAuthentication(app);
  mountApiAccess(app, deps.authorizeApiAccess);
  app.onError((_, c) => c.json({ error: 'service_unavailable' }, 503));
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}
