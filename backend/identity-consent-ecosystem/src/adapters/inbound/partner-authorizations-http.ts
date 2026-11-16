import type { Hono } from 'hono';
import type { PartnerAuthorizations } from '../../application/partner-authorizations';
import type { AuthorizeApiAccess } from './api-access-http';
import { readJson, webUserRoute } from './web-user-route';

// A customer decides which partner may request an operation on their behalf; a partner never reaches these routes.
export function mountPartnerAuthorizations(app: Hono<{ Bindings: IdentityEnv }>, deps: { authorizeApiAccess: AuthorizeApiAccess; authorizations: PartnerAuthorizations }) {
  const { authorizations } = deps;
  const route = webUserRoute<'partner-authorizations:read' | 'partner-authorizations:write'>(deps.authorizeApiAccess,
    { failed: 'partner_authorization_failed', bodyCancelFailed: 'partner_authorization_body_cancel_failed' });

  app.get('/api/v1/me/partner-authorizations', route('partner-authorizations:read', async (_c, principal, _traceId, reply) =>
    reply(await authorizations.list(principal), 200)));

  app.post('/api/v1/me/partner-authorizations', route('partner-authorizations:write', async (c, principal, traceId, reply) => {
    const result = await authorizations.grant({ principal, body: await readJson(c.req.raw), traceId });
    if (result.status === 'invalid') return reply({ error: 'invalid_request' }, 400);
    if (result.status === 'partner_not_found') return reply({ error: 'partner_not_found' }, 404);
    return reply(result.authorization, 201);
  }));

  app.post('/api/v1/me/partner-authorizations/:authorizationId/revoke', route('partner-authorizations:write', async (c, principal, traceId, reply) => {
    const result = await authorizations.revoke({ principal, authorizationId: c.req.param('authorizationId') ?? '', traceId });
    if (result.status === 'invalid') return reply({ error: 'invalid_request' }, 400);
    if (result.status === 'not_found') return reply({ error: 'not_found' }, 404);
    if (result.status === 'not_active') return reply({ error: 'authorization_not_active' }, 409);
    return reply(result.authorization, 200);
  }));
}
