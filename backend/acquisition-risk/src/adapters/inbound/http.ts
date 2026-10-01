import { Hono } from 'hono';

export function createHttp() {
  const app = new Hono<{ Bindings: AcquisitionEnv }>();
  app.get('/health', (c) => c.json({ service: 'acquisition-risk', status: 'alive' }));
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}
