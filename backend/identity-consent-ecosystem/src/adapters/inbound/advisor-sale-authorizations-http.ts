import type { Hono } from 'hono';
import type { AdvisorSaleAuthorizations } from '../../application/advisor-sale-authorizations';
import type { AuthorizeApiAccess } from './api-access-http';
import { readJson, webUserRoute } from './web-user-route';

// A customer decides which advisor may prepare a sale on their behalf; the advisor never reaches these routes.
export function mountAdvisorSaleAuthorizations(app: Hono<{ Bindings: IdentityEnv }>, deps: { authorizeApiAccess: AuthorizeApiAccess; authorizations: AdvisorSaleAuthorizations }) {
  const { authorizations } = deps;
  const route = webUserRoute<'advisor-sale-authorizations:read' | 'advisor-sale-authorizations:write'>(deps.authorizeApiAccess,
    { failed: 'advisor_sale_authorization_failed', bodyCancelFailed: 'advisor_sale_authorization_body_cancel_failed' });

  app.get('/api/v1/me/advisor-sale-authorizations', route('advisor-sale-authorizations:read', async (_c, principal, _traceId, reply) =>
    reply(await authorizations.list(principal), 200)));

  app.post('/api/v1/me/advisor-sale-authorizations', route('advisor-sale-authorizations:write', async (c, principal, traceId, reply) => {
    const result = await authorizations.grant({ principal, body: await readJson(c.req.raw), traceId });
    if (result.status === 'invalid') return reply({ error: 'invalid_request' }, 400);
    if (result.status === 'advisor_not_found') return reply({ error: 'advisor_not_found' }, 404);
    return reply(result.authorization, 201);
  }));

  app.post('/api/v1/me/advisor-sale-authorizations/:authorizationId/revoke', route('advisor-sale-authorizations:write', async (c, principal, traceId, reply) => {
    const result = await authorizations.revoke({ principal, authorizationId: c.req.param('authorizationId') ?? '', traceId });
    if (result.status === 'invalid') return reply({ error: 'invalid_request' }, 400);
    if (result.status === 'not_found') return reply({ error: 'not_found' }, 404);
    if (result.status === 'not_active') return reply({ error: 'authorization_not_active' }, 409);
    return reply(result.authorization, 200);
  }));
}
