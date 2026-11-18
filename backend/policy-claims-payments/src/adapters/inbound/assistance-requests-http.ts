import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { assistanceRecord, assistanceRequestCreateOperation, assistanceRequestReadOperation, assistanceRequestsPath, parseAssistanceRequestBody } from '@solventa/contracts';
import type { AssistanceRequests } from '../../application/assistance-requests';
import type { AssistanceOwner } from '../../application/ports/assistance-request';
import { UUID } from '../../domain/financial';

type Operation = typeof assistanceRequestCreateOperation | typeof assistanceRequestReadOperation;
type AuthorizationRequest = { traceId: string; operation: Operation } & (
  { kind: 'mobile'; token: string } | { kind: 'web'; method: 'GET' | 'POST'; requestOrigin: string; origin: string; cookie: string }
);
export type AssistanceRequestsHttpDependencies = {
  authorize(input: AuthorizationRequest): Promise<unknown>;
  requests: Pick<AssistanceRequests, 'create' | 'get' | 'list'>;
};
type Status = 200 | 201 | 400 | 401 | 403 | 404 | 405 | 409 | 415 | 503;
type Reply = (body: Record<string, unknown>, status: Status) => Response;
const MAX_BODY_BYTES = 4096;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,128}$/;

// Web and native customers use one contract. The owner always comes from the verified session, never from a field of the request.
export function mountAssistanceRequests(app: Hono<{ Bindings: PolicyEnv }>, deps: AssistanceRequestsHttpDependencies) {
  const route = (allow: readonly string[], operation: (method: string) => Operation,
    work: (c: Context<{ Bindings: PolicyEnv }>, owner: AssistanceOwner, traceId: string, reply: Reply) => Promise<Response>) => async (c: Context<{ Bindings: PolicyEnv }>) => {
    const supplied = c.req.header('x-trace-id') ?? '';
    const traceId = UUID.test(supplied) ? supplied.toLowerCase() : crypto.randomUUID();
    const reply: Reply = (body, status) => c.json({ ...body, traceId }, status, { 'cache-control': 'no-store', 'x-trace-id': traceId, 'x-content-type-options': 'nosniff' });
    if (!allow.includes(c.req.method)) { c.header('Allow', allow.join(', ')); return reply({ error: 'method_not_allowed' }, 405); }
    const method = c.req.method as 'GET' | 'POST';
    const auth = c.req.header('authorization');
    const cookie = getCookie(c, (c.env.APP_ENV === 'local' ? '' : '__Host-') + 'solventa-session') ?? '';
    const token = auth?.match(/^Bearer ([A-Za-z0-9_.-]+)$/i)?.[1];
    if (auth !== undefined && (!token || cookie || c.req.header('origin'))) return reply({ error: 'invalid_request' }, 400);
    const base = { operation: operation(method), traceId };
    const request: AuthorizationRequest = token ? { ...base, kind: 'mobile', token }
      : { ...base, kind: 'web', method, requestOrigin: new URL(c.req.url).origin, cookie, origin: c.req.header('origin') ?? '' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const decision = await Promise.race([deps.authorize(request), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('access_deadline')), 2000); })]).catch(() => null);
      clearTimeout(timer);
      if (!assistanceRecord(decision)) return reply({ error: 'access_unavailable' }, 503);
      if (decision.allowed !== true) {
        if (decision.status === 400) return reply({ error: 'invalid_request' }, 400);
        if (decision.status === 401) return reply({ error: 'unauthorized' }, 401);
        if (decision.status === 403) return reply({ error: 'forbidden' }, 403);
        return reply({ error: 'access_unavailable' }, 503);
      }
      const { actor } = decision;
      if (!assistanceRecord(actor) || actor.kind !== 'user' || actor.channel !== request.kind || !Array.isArray(actor.operations) || !actor.operations.includes(request.operation)
        || !assistanceRecord(actor.principal) || typeof actor.principal.clientId !== 'string' || !UUID.test(actor.principal.clientId)
        || typeof actor.principal.subjectToken !== 'string' || !UUID.test(actor.principal.subjectToken)) return reply({ error: 'access_unavailable' }, 503);
      return await work(c, { clientId: actor.principal.clientId.toLowerCase(), subjectToken: actor.principal.subjectToken.toLowerCase() }, traceId, reply);
    } catch { return reply({ error: 'service_unavailable' }, 503); }
    finally { clearTimeout(timer); }
  };

  app.all(assistanceRequestsPath, route(['GET', 'POST'], method => method === 'POST' ? assistanceRequestCreateOperation : assistanceRequestReadOperation, async (c, owner, traceId, reply) => {
    if (c.req.method === 'GET') return reply({ simulated: true, requests: await deps.requests.list(owner) }, 200);
    const key = c.req.header('idempotency-key') ?? '';
    if (!IDEMPOTENCY_KEY.test(key)) return reply({ error: 'invalid_request', fields: ['idempotencyKey'] }, 400);
    if (!/^application\/json(\s*;|$)/i.test(c.req.header('content-type') ?? '')) return reply({ error: 'unsupported_media_type' }, 415);
    const declared = Number(c.req.header('content-length') ?? 0);
    if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) return reply({ error: 'invalid_request', fields: ['body'] }, 400);
    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return reply({ error: 'invalid_request', fields: ['body'] }, 400);
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = undefined; }
    const parsed = parseAssistanceRequestBody(body);
    if (!parsed) return reply({ error: 'invalid_request' }, 400);
    const place = parsed.place.kind === 'device' ? { kind: 'device' as const, latitude: parsed.place.coordinates.latitude, longitude: parsed.place.coordinates.longitude }
      : { kind: 'address' as const, address: parsed.place.address };
    const result = await deps.requests.create(owner, { providerId: parsed.providerId, place }, key, traceId);
    switch (result.status) {
      case 'created': return reply({ simulated: true, request: result.request }, 201);
      case 'replayed': return reply({ simulated: true, request: result.request }, 200);
      case 'provider_not_found': return reply({ error: 'not_found' }, 404);
      case 'idempotency_conflict': return reply({ error: 'idempotency_conflict' }, 409);
      case 'directory_unavailable': return reply({ error: 'directory_unavailable' }, 503);
    }
  }));

  app.all('/api/v1/assistance/requests/:requestId', route(['GET'], () => assistanceRequestReadOperation, async (c, owner, _traceId, reply) => {
    const { requestId } = c.req.param();
    if (!UUID.test(requestId)) return reply({ error: 'not_found' }, 404);
    const found = await deps.requests.get(owner, requestId.toLowerCase());
    return found ? reply({ simulated: true, request: found }, 200) : reply({ error: 'not_found' }, 404);
  }));
}
