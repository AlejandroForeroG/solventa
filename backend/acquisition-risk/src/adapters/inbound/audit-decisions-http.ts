import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AuditDecisions, AuditQuery } from '../../application/audit-decisions';

export type AuditHttpDependencies = { decisions: Pick<AuditDecisions, 'list' | 'get'>; authorize(input: { kind: 'web'; operation: 'underwriting-decisions:read'; traceId: string; method: 'GET'; requestOrigin: string; origin: string; cookie: string }): Promise<unknown> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
function date(value: string) { return Number(value.slice(0, 4)) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().startsWith(value); }
export function auditQuery(params: URLSearchParams): AuditQuery | null {
  const query: AuditQuery = {};
  for (const [key, value] of params) {
    if (params.getAll(key).length !== 1) return null;
    if (key === 'reference' && (UUID.test(value) || /^COT-\d{4}-\d{5,19}$/.test(value))) query.reference = value.startsWith('COT-') ? value : value.toLowerCase();
    else if (key === 'product' && (value === 'vida_hipotecario' || value === 'flight_delay')) query.product = value;
    else if (key === 'outcome' && (value === 'accepted' || value === 'declined' || value === 'preliminary')) query.outcome = value;
    else if ((key === 'from' || key === 'to') && date(value)) query[key] = value;
    else if (key === 'before' && UUID.test(value)) query.before = value.toLowerCase();
    else return null;
  }
  return query.from && query.to && query.from > query.to ? null : query;
}
export function mountAuditDecisions(app: Hono<{ Bindings: AcquisitionEnv }>, deps: AuditHttpDependencies) {
  app.all('/api/v1/underwriting-decisions', handle);
  app.all('/api/v1/underwriting-decisions/:decisionId', handle);
  async function handle(c: Context<{ Bindings: AcquisitionEnv }>) {
    const supplied = c.req.header('x-trace-id') ?? '';
    const traceId = UUID.test(supplied) ? supplied.toLowerCase() : crypto.randomUUID();
    const reply = (body: object, status: 200 | 400 | 401 | 403 | 404 | 405 | 503) => c.json({ ...body, traceId }, status,
      { 'cache-control': 'no-store', 'x-trace-id': traceId, 'x-content-type-options': 'nosniff' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (c.req.method !== 'GET') { c.header('Allow', 'GET'); return reply({ error: 'method_not_allowed' }, 405); }
      if (c.req.header('authorization') !== undefined) return reply({ error: 'invalid_request' }, 400);
      const access = await Promise.race([deps.authorize({ kind: 'web', operation: 'underwriting-decisions:read', traceId, method: 'GET',
        requestOrigin: new URL(c.req.url).origin, origin: c.req.header('origin') ?? '', cookie: getCookie(c, (c.env.APP_ENV === 'local' ? '' : '__Host-') + 'solventa-session') ?? '' }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('access_deadline')), 2000); })]);
      clearTimeout(timer);
      if (!record(access)) return reply({ error: 'access_unavailable' }, 503);
      if (access.allowed !== true) {
        if ((access.status === 401 && access.error === 'unauthorized') || (access.status === 403 && access.error === 'forbidden')) return reply({ error: access.error }, access.status);
        return reply({ error: 'access_unavailable' }, 503);
      }
      const actor = access.actor;
      if (!record(actor) || actor.kind !== 'user' || actor.channel !== 'web' || !Array.isArray(actor.operations) || !actor.operations.includes('underwriting-decisions:read')
        || !record(actor.principal) || typeof actor.principal.clientId !== 'string' || !UUID.test(actor.principal.clientId)
        || typeof actor.principal.subjectToken !== 'string' || !UUID.test(actor.principal.subjectToken)
        || typeof actor.authorizationExpiresAt !== 'string' || !(Date.parse(actor.authorizationExpiresAt) > Date.now())
        || Date.parse(actor.authorizationExpiresAt) > Date.now() + 5500) return reply({ error: 'access_unavailable' }, 503);
      const reader = { clientId: actor.principal.clientId, traceId, expiresAt: actor.authorizationExpiresAt };
      const id = c.req.param('decisionId');
      const params = new URL(c.req.url).searchParams;
      if (id !== undefined) {
        if (!UUID.test(id) || params.size) return reply({ error: 'invalid_request' }, 400);
        const detail = await deps.decisions.get(id.toLowerCase(), reader);
        if (!(Date.parse(reader.expiresAt) > Date.now())) return reply({ error: 'access_unavailable' }, 503);
        return detail ? reply({ decision: detail }, 200) : reply({ error: 'not_found' }, 404);
      }
      const query = auditQuery(params);
      if (!query) return reply({ error: 'invalid_request' }, 400);
      const result = await deps.decisions.list(query, reader);
      if (!(Date.parse(reader.expiresAt) > Date.now())) return reply({ error: 'access_unavailable' }, 503);
      return reply(result, 200);
    } catch { return reply({ error: 'audit_unavailable' }, 503); }
    finally { clearTimeout(timer); }
  }
}
