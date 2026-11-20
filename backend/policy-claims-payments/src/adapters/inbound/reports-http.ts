import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Reports } from '../../application/reports';
import type { ReportActor, ReportQuery, RevisionSummary } from '../../application/ports/report';
import { isReportDestination, ReportError } from '../../domain/report';

export type ReportOperationName = 'reports:generate' | 'reports:read' | 'reports:download' | 'reports:send';
export type ReportsHttpDependencies = {
  reports: Pick<Reports, 'generate' | 'list' | 'download' | 'send'>;
  authorize(input: { kind: 'web'; operation: ReportOperationName; traceId: string; method: 'GET' | 'POST'; requestOrigin: string; origin: string; cookie: string }): Promise<unknown>;
};
type Status = 200 | 201 | 400 | 401 | 403 | 404 | 405 | 409 | 415 | 503;
type Reply = (body: object, status: Status) => Response;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_BODY_BYTES = 1024;
const BUDGET_MS = 120;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function reportQuery(params: URLSearchParams): ReportQuery | null {
  const query: ReportQuery = {};
  for (const [key, value] of params) {
    if (params.getAll(key).length !== 1) return null;
    if (key === 'period' && PERIOD.test(value)) query.period = value;
    else if (key === 'destination' && isReportDestination(value)) query.destination = value;
    else if (key === 'before' && UUID.test(value)) query.before = value.toLowerCase();
    else return null;
  }
  return query;
}
const present = ({ id, delivery, ...report }: RevisionSummary) => ({ reportId: id, ...report, ...(delivery ? { delivery } : {}) });

async function readJson(c: Context<{ Bindings: PolicyEnv }>): Promise<unknown | undefined> {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) return undefined;
  const text = await c.req.text();
  try { return new TextEncoder().encode(text).length > MAX_BODY_BYTES ? undefined : JSON.parse(text); } catch { return undefined; }
}

export function mountReports(app: Hono<{ Bindings: PolicyEnv }>, deps: ReportsHttpDependencies) {
  // The session alone never opens a report: each operation needs its own grant, checked by Identity on every request.
  const route = (operation: ReportOperationName, method: 'GET' | 'POST', work: (c: Context<{ Bindings: PolicyEnv }>, actor: ReportActor, traceId: string, reply: Reply) => Promise<Response>) =>
    async (c: Context<{ Bindings: PolicyEnv }>) => {
      const supplied = c.req.header('x-trace-id') ?? '';
      const traceId = UUID.test(supplied) ? supplied.toLowerCase() : crypto.randomUUID();
      const reply: Reply = (body, status) => c.json({ ...body, traceId }, status, { 'cache-control': 'no-store', 'x-trace-id': traceId, 'x-content-type-options': 'nosniff' });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (c.req.header('authorization') !== undefined) return reply({ error: 'invalid_request' }, 400);
        const access = await Promise.race([deps.authorize({ kind: 'web', operation, traceId, method, requestOrigin: new URL(c.req.url).origin, origin: c.req.header('origin') ?? '',
          cookie: getCookie(c, (c.env.APP_ENV === 'local' ? '' : '__Host-') + 'solventa-session') ?? '' }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('access_deadline')), 2000); })]);
        clearTimeout(timer);
        if (!record(access)) return reply({ error: 'access_unavailable' }, 503);
        if (access.allowed !== true) {
          if ((access.status === 401 && access.error === 'unauthorized') || (access.status === 403 && access.error === 'forbidden')) return reply({ error: access.error }, access.status);
          if (access.status === 400 && access.error === 'invalid_request') return reply({ error: 'invalid_request' }, 400);
          return reply({ error: 'access_unavailable' }, 503);
        }
        const principal = access.actor;
        if (!record(principal) || principal.kind !== 'user' || principal.channel !== 'web' || !Array.isArray(principal.operations) || principal.operations.length !== 1 || principal.operations[0] !== operation
          || !record(principal.principal) || typeof principal.principal.clientId !== 'string' || !UUID.test(principal.principal.clientId)
          || typeof principal.authorizationExpiresAt !== 'string' || !(Date.parse(principal.authorizationExpiresAt) > Date.now())
          || Date.parse(principal.authorizationExpiresAt) > Date.now() + 5500) return reply({ error: 'access_unavailable' }, 503);
        return await work(c, { clientId: principal.principal.clientId.toLowerCase(), traceId, expiresAt: principal.authorizationExpiresAt }, traceId, reply);
      } catch (error) {
        if (error instanceof ReportError) return reply({ error: error.code === 'invalid_period' || error.code === 'period_in_future' ? 'invalid_request' : error.code, ...(error.code === 'invalid_period' || error.code === 'period_in_future' ? { fields: ['period'] } : {}) },
          error.code === 'invalid_period' || error.code === 'period_in_future' ? 400 : 503);
        if (error instanceof Error && error.message === 'report_integrity_violation') return reply({ error: 'integrity_violation' }, 409);
        return reply({ error: 'service_unavailable' }, 503);
      } finally { clearTimeout(timer); }
    };
  const methodNotAllowed = (c: Context<{ Bindings: PolicyEnv }>, allow: string) => {
    c.header('Allow', allow);
    const traceId = crypto.randomUUID();
    return c.json({ error: 'method_not_allowed', traceId }, 405, { 'cache-control': 'no-store', 'x-trace-id': traceId, 'x-content-type-options': 'nosniff' });
  };

  const list = route('reports:read', 'GET', async (c, actor, _traceId, reply) => {
    const query = reportQuery(new URL(c.req.url).searchParams);
    if (!query) return reply({ error: 'invalid_request' }, 400);
    const page = await deps.reports.list(query, actor);
    return reply({ items: page.items.map(present), next: page.next }, 200);
  });
  const generate = route('reports:generate', 'POST', async (c, actor, _traceId, reply) => {
    if (!/^application\/json(\s*;|$)/i.test(c.req.header('content-type') ?? '')) return reply({ error: 'unsupported_media_type' }, 415);
    const body = await readJson(c);
    if (!record(body) || Object.keys(body).length !== 3 || typeof body.period !== 'string' || !PERIOD.test(body.period) || !isReportDestination(body.destination) || body.format !== 'csv') return reply({ error: 'invalid_request' }, 400);
    const { report, created } = await deps.reports.generate({ period: body.period, destination: body.destination }, actor);
    return reply({ report: present(report), created }, created ? 201 : 200);
  });
  app.all('/api/v1/reports', c => c.req.method === 'GET' ? list(c) : c.req.method === 'POST' ? generate(c) : methodNotAllowed(c, 'GET, POST'));

  const download = route('reports:download', 'GET', async (c, actor, traceId, reply) => {
    const { reportId } = c.req.param();
    const params = new URL(c.req.url).searchParams;
    const file = params.get('file') ?? 'csv';
    if (!UUID.test(reportId) || [...params.keys()].some(key => key !== 'file') || params.getAll('file').length > 1 || (file !== 'csv' && file !== 'manifest')) return reply({ error: 'invalid_request' }, 400);
    const result = await deps.reports.download(reportId.toLowerCase(), file, actor);
    if (result.status === 'not_found') return reply({ error: 'not_found' }, 404);
    return new Response(result.body, { status: 200, headers: { 'content-type': result.contentType, 'content-disposition': `attachment; filename="${result.filename}"`, 'x-report-hash': result.contentHash,
      'cache-control': 'no-store', 'x-trace-id': traceId, 'x-content-type-options': 'nosniff' } });
  });
  app.all('/api/v1/reports/:reportId/download', c => c.req.method === 'GET' ? download(c) : methodNotAllowed(c, 'GET'));

  const send = route('reports:send', 'POST', async (c, actor, _traceId, reply) => {
    const { reportId } = c.req.param();
    if (!UUID.test(reportId)) return reply({ error: 'invalid_request' }, 400);
    if (!/^application\/json(\s*;|$)/i.test(c.req.header('content-type') ?? '')) return reply({ error: 'unsupported_media_type' }, 415);
    const body = await readJson(c);
    if (!record(body) || Object.keys(body).length !== 0) return reply({ error: 'invalid_request' }, 400);
    const sent = await deps.reports.send(reportId.toLowerCase(), actor);
    if (sent.status === 'not_found') return reply({ error: 'not_found' }, 404);
    // The destination, status and duration identify the call; no report, policy or person identifier is logged.
    console.log(JSON.stringify({ event: 'report_delivery', environment: c.env.APP_ENV, traceId: actor.traceId, destination: sent.destination, status: sent.delivery.status,
      durationMs: sent.durationMs, ...(sent.durationMs > BUDGET_MS ? { overBudget: true } : {}) }));
    return reply({ reportId: reportId.toLowerCase(), delivery: sent.delivery }, 200);
  });
  app.all('/api/v1/reports/:reportId/delivery', c => c.req.method === 'POST' ? send(c) : methodNotAllowed(c, 'POST'));
}
