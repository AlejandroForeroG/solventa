import { Hono } from 'hono';

export function createHttp() {
  const app = new Hono<{ Bindings: PolicyEnv }>();
  app.get('/health', (c) => c.json({ service: 'policy-claims-payments', status: 'alive' }));
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}
