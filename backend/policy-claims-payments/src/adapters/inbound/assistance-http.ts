import type { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { assistanceOperation, assistanceRecord, assistanceSearchPath, parseAssistanceSearch } from '@solventa/contracts';
import type { AssistanceDirectoryResult, AssistanceSearch } from '../../domain/assistance-search';
import { UUID } from '../../domain/financial';

type AuthorizationRequest = { traceId: string; operation: typeof assistanceOperation } & (
  { kind: 'mobile'; token: string } | { kind: 'web'; method: 'POST'; requestOrigin: string; origin: string; cookie: string }
);
export type AssistanceHttpDependencies = {
  authorize(input: AuthorizationRequest): Promise<unknown>;
  search(input: AssistanceSearch): AssistanceDirectoryResult;
};

export function mountAssistance(app: Hono<{ Bindings: PolicyEnv }>, deps: AssistanceHttpDependencies,
  smallBody: (request: Request) => Promise<unknown>) {
  app.all(assistanceSearchPath, async c => {
    const supplied = c.req.header('x-trace-id') ?? '';
    const traceId = UUID.test(supplied) ? supplied.toLowerCase() : crypto.randomUUID();
    const reply = (body: Record<string, unknown>, status: 200 | 400 | 401 | 403 | 405 | 503) =>
      c.json({ ...body, traceId }, status, {
        'x-trace-id': traceId, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      });
    if (c.req.method !== 'POST') {
      c.header('Allow', 'POST');
      return reply({ error: 'method_not_allowed' }, 405);
    }

    const auth = c.req.header('authorization');
    const cookie = getCookie(c, (c.env.APP_ENV === 'local' ? '' : '__Host-') + 'solventa-session') ?? '';
    const token = auth?.match(/^Bearer ([A-Za-z0-9_.-]+)$/i)?.[1];
    if (auth !== undefined && (!token || cookie || c.req.header('origin'))) return reply({ error: 'invalid_request' }, 400);
    const base: Pick<AuthorizationRequest, 'operation' | 'traceId'> = { operation: assistanceOperation, traceId };
    const request: AuthorizationRequest = token ? { ...base, kind: 'mobile', token }
      : { ...base, kind: 'web', method: 'POST', requestOrigin: new URL(c.req.url).origin,
        cookie, origin: c.req.header('origin') ?? '' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const decision = await Promise.race([deps.authorize(request),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('access_deadline')), 2000); })])
        .catch(() => null);
      if (!assistanceRecord(decision)) return reply({ error: 'access_unavailable' }, 503);
      if (decision.allowed !== true) {
        if (decision.status === 400) return reply({ error: 'invalid_request' }, 400);
        if (decision.status === 401) return reply({ error: 'unauthorized' }, 401);
        if (decision.status === 403) return reply({ error: 'forbidden' }, 403);
        return reply({ error: 'access_unavailable' }, 503);
      }
      const { actor } = decision;
      if (!assistanceRecord(actor) || actor.kind !== 'user' || actor.channel !== request.kind
        || !Array.isArray(actor.operations) || !actor.operations.includes(assistanceOperation)
        || !assistanceRecord(actor.principal) || typeof actor.principal.clientId !== 'string' || !UUID.test(actor.principal.clientId)
        || typeof actor.principal.subjectToken !== 'string' || !UUID.test(actor.principal.subjectToken)) {
        return reply({ error: 'access_unavailable' }, 503);
      }
      const search = parseAssistanceSearch(await smallBody(c.req.raw));
      if (!search) return reply({ error: 'invalid_request' }, 400);
      const result = deps.search(search);
      if (result.status === 'ok') return reply({ simulated: result.simulated, providers: result.providers }, 200);
      if (result.status === 'invalid_input') return reply({ error: 'invalid_request' }, 400);
      return reply({ error: 'directory_unavailable' }, 503);
    } catch {
      return reply({ error: 'directory_unavailable' }, 503);
    } finally { clearTimeout(timer); }
  });
}
