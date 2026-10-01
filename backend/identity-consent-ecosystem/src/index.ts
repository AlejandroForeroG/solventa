import { Hono } from 'hono';

const app = new Hono<{ Bindings: Env }>();
app.get('/health', (c) => c.json({ service: 'identity-consent-ecosystem', status: 'scaffold' }));
app.notFound((c) => c.json({ error: 'not_found' }, 404));

export default app;
