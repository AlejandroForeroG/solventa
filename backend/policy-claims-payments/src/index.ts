import { Hono } from 'hono';

const app = new Hono<{ Bindings: Env }>();
app.get('/health', (c) => c.json({ service: 'policy-claims-payments', status: 'scaffold' }));
app.notFound((c) => c.json({ error: 'not_found' }, 404));

export default app;
