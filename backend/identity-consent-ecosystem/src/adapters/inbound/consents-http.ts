import type { Hono } from 'hono';
import type { Consents } from '../../application/consents';
import { isConsentCode } from '../../domain/consent';
import type { AuthorizeApiAccess } from './api-access-http';
import { readJson, webUserRoute } from './web-user-route';

export function mountConsents(app: Hono<{ Bindings: IdentityEnv }>, deps: { authorizeApiAccess: AuthorizeApiAccess; consents: Consents }) {
  const { consents } = deps;

  const route = webUserRoute<'consents:read' | 'consents:write'>(deps.authorizeApiAccess, { failed: 'consent_failed', bodyCancelFailed: 'consent_body_cancel_failed' });

  app.get('/api/v1/consents/terms', route('consents:read', async (_c, _principal, _traceId, reply) => reply(consents.terms(), 200)));

  app.get('/api/v1/consents', route('consents:read', async (c, principal, traceId, reply) => {
    const after = c.req.query('after');
    if (after !== undefined && !isConsentCode(after)) return reply({ error: 'invalid_request' }, 400);
    return reply(await consents.list(principal, after, traceId), 200);
  }));

  app.post('/api/v1/consents', route('consents:write', async (c, principal, traceId, reply) => {
    const result = await consents.grant({ principal, idempotencyKey: c.req.header('Idempotency-Key') ?? null, body: await readJson(c.req.raw), traceId });
    if (result.status === 'invalid') return reply({ error: 'invalid_request' }, 400);
    if (result.status === 'terms_outdated') return reply({ error: 'terms_outdated' }, 409);
    if (result.status === 'idempotency_conflict') return reply({ error: 'idempotency_key_reused' }, 409);
    return reply(result.consent, result.status === 'created' ? 201 : 200);
  }));

  app.post('/api/v1/consents/declines', route('consents:write', async (c, principal, traceId, reply) => {
    const result = await consents.decline({ principal, body: await readJson(c.req.raw), traceId });
    if (result.status === 'invalid') return reply({ error: 'invalid_request' }, 400);
    if (result.status === 'terms_outdated') return reply({ error: 'terms_outdated' }, 409);
    return new Response(null, { status: 204, headers: { 'x-trace-id': traceId, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  }));

  app.post('/api/v1/consents/:consentId/revoke', route('consents:write', async (c, principal, traceId, reply) => {
    const result = await consents.revoke({ principal, consentCode: c.req.param('consentId') ?? '', traceId });
    if (result.status === 'invalid') return reply({ error: 'invalid_request' }, 400);
    if (result.status === 'not_found') return reply({ error: 'not_found' }, 404);
    if (result.status === 'not_active') return reply({ error: 'consent_not_active' }, 409);
    return reply(result.consent, 200);
  }));
}
