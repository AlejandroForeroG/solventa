import { Hono } from 'hono';
import { mountAuthentication } from './authentication-http';

export function createHttp() {
  const app = new Hono<{ Bindings: IdentityEnv }>();
  app.get('/health', (c) => c.json({ service: 'identity-consent-ecosystem', status: 'alive' }));
  mountAuthentication(app);
  app.onError((_, c) => c.json({ error: 'service_unavailable' }, 503));
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}
