import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { isClaimState } from '../../domain/claims';
import type { ClaimInbox } from '../../application/claim-inbox';
import type { ClaimQuery } from '../../application/ports/claims';

export type ClaimsHttpDependencies = {
  inbox: Pick<ClaimInbox, 'list'>;
  authorize(input: { kind: 'web'; operation: 'claims:read'; traceId: string; method: 'GET'; requestOrigin: string; origin: string; cookie: string }): Promise<unknown>;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLAIM_NUMBER = /^SIN-\d{4}-\d{5}$/;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function claimQuery(params: URLSearchParams): ClaimQuery | null {
  const query: ClaimQuery = {};
  for (const [key, value] of params) {
    if (params.getAll(key).length !== 1) return null;
    if (key === 'state' && isClaimState(value)) query.state = value;
    else if (key === 'overdue' && value === 'true') query.overdue = true;
    else if (key === 'query' && (CLAIM_NUMBER.test(value) || UUID.test(value))) query.query = CLAIM_NUMBER.test(value) ? value : value.toLowerCase();
    else if (key === 'before' && UUID.test(value)) query.before = value.toLowerCase();
    else return null;
  }
  return query;
}

export function mountClaims(app: Hono<{ Bindings: PolicyEnv }>, deps: ClaimsHttpDependencies) {
  app.all('/api/v1/claims', handle);
  async function handle(c: Context<{ Bindings: PolicyEnv }>) {
    const supplied = c.req.header('x-trace-id') ?? '';
    const traceId = UUID.test(supplied) ? supplied.toLowerCase() : crypto.randomUUID();
    const reply = (body: object, status: 200 | 400 | 401 | 403 | 405 | 503) => c.json({ ...body, traceId }, status,
      { 'cache-control': 'no-store', 'x-trace-id': traceId, 'x-content-type-options': 'nosniff' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (c.req.method !== 'GET') { c.header('Allow', 'GET'); return reply({ error: 'method_not_allowed' }, 405); }
      if (c.req.header('authorization') !== undefined) return reply({ error: 'invalid_request' }, 400);
      const access = await Promise.race([deps.authorize({ kind: 'web', operation: 'claims:read', traceId, method: 'GET', requestOrigin: new URL(c.req.url).origin,
        origin: c.req.header('origin') ?? '', cookie: getCookie(c, (c.env.APP_ENV === 'local' ? '' : '__Host-') + 'solventa-session') ?? '' }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('access_deadline')), 2000); })]);
      clearTimeout(timer);
      if (!record(access)) return reply({ error: 'access_unavailable' }, 503);
      if (access.allowed !== true) {
        if ((access.status === 401 && access.error === 'unauthorized') || (access.status === 403 && access.error === 'forbidden')) return reply({ error: access.error }, access.status);
        if (access.status === 400 && access.error === 'invalid_request') return reply({ error: 'invalid_request' }, 400);
        return reply({ error: 'access_unavailable' }, 503);
      }
      const actor = access.actor;
      if (!record(actor) || actor.kind !== 'user' || actor.channel !== 'web' || !Array.isArray(actor.operations) || !actor.operations.includes('claims:read')
        || !record(actor.principal) || typeof actor.principal.clientId !== 'string' || !UUID.test(actor.principal.clientId)
        || typeof actor.authorizationExpiresAt !== 'string' || !(Date.parse(actor.authorizationExpiresAt) > Date.now())
        || Date.parse(actor.authorizationExpiresAt) > Date.now() + 5500) return reply({ error: 'access_unavailable' }, 503);
      const query = claimQuery(new URL(c.req.url).searchParams);
      if (!query) return reply({ error: 'invalid_request' }, 400);
      const page = await deps.inbox.list(query, { clientId: actor.principal.clientId.toLowerCase(), traceId, expiresAt: actor.authorizationExpiresAt });
      return reply(page, 200);
    } catch { return reply({ error: 'service_unavailable' }, 503); }
    finally { clearTimeout(timer); }
  }
}
