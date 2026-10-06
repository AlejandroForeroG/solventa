import { Hono } from 'hono';

export function createHttp() {
  const app = new Hono<{ Bindings: IdentityEnv }>();
  app.get('/health', (c) => c.json({ service: 'identity-consent-ecosystem', status: 'alive' }));
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}
