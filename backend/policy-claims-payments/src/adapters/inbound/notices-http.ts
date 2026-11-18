import type { Context, Hono } from 'hono';
import type { Notices, PushChoices } from '../../application/notices';
import { UUID } from '../../domain/financial';

type Operation = 'notices:read' | 'notices:receipt';
export type NoticesHttpDependencies = {
  authorize(input: { kind: 'mobile'; operation: Operation; token: string; traceId: string }): Promise<unknown>;
  notices: Pick<Notices, 'list' | 'receipt'>;
};
type Status = 200 | 400 | 401 | 403 | 404 | 405 | 409 | 415 | 503;
type Reply = (body: Record<string, unknown>, status: Status) => Response;
const MAX_BODY_BYTES = 256;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const categories = ['policy', 'payments', 'claims', 'commercial'] as const;

function choicesOf(value: unknown): PushChoices | null {
  if (!record(value) || Object.keys(value).length !== categories.length) return null;
  return categories.every(category => typeof value[category] === 'boolean') ? value as PushChoices : null;
}

// Only the native customer reads their notices and reports what the device did with them. The owner always comes from the verified session.
export function mountNotices(app: Hono<{ Bindings: PolicyEnv }>, deps: NoticesHttpDependencies) {
  const route = (method: 'GET' | 'POST', operation: Operation,
    work: (c: Context<{ Bindings: PolicyEnv }>, owner: { clientId: string }, decision: Record<string, unknown>, traceId: string, reply: Reply) => Promise<Response>) => async (c: Context<{ Bindings: PolicyEnv }>) => {
    const supplied = c.req.header('x-trace-id') ?? '';
    const traceId = UUID.test(supplied) ? supplied.toLowerCase() : crypto.randomUUID();
    const reply: Reply = (body, status) => c.json({ ...body, traceId }, status, { 'cache-control': 'no-store', 'x-trace-id': traceId, 'x-content-type-options': 'nosniff' });
    if (c.req.method !== method) { c.header('Allow', method); return reply({ error: 'method_not_allowed' }, 405); }
    const token = c.req.header('authorization')?.match(/^Bearer ([A-Za-z0-9_.-]+)$/i)?.[1];
    if (!token) return reply({ error: 'unauthorized' }, 401);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const decision = await Promise.race([deps.authorize({ kind: 'mobile', operation, token, traceId }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('access_deadline')), 2000); })]).catch(() => null);
      clearTimeout(timer);
      if (!record(decision)) return reply({ error: 'access_unavailable' }, 503);
      if (decision.allowed !== true) {
        if (decision.status === 400) return reply({ error: 'invalid_request' }, 400);
        if (decision.status === 401) return reply({ error: 'unauthorized' }, 401);
        if (decision.status === 403) return reply({ error: 'forbidden' }, 403);
        return reply({ error: 'access_unavailable' }, 503);
      }
      const { actor } = decision;
      if (!record(actor) || actor.kind !== 'user' || actor.channel !== 'mobile' || !Array.isArray(actor.operations) || !actor.operations.includes(operation)
        || !record(actor.principal) || typeof actor.principal.clientId !== 'string' || !UUID.test(actor.principal.clientId)) return reply({ error: 'access_unavailable' }, 503);
      return await work(c, { clientId: actor.principal.clientId.toLowerCase() }, decision, traceId, reply);
    } catch { return reply({ error: 'service_unavailable' }, 503); }
    finally { clearTimeout(timer); }
  };

  app.all('/api/v1/mobile/notices', route('GET', 'notices:read', async (_c, owner, decision, traceId, reply) => {
    // Without the caller's choices nothing is offered: the stored matrix alone is never assumed.
    const choices = choicesOf(decision.pushChoices);
    if (!choices) return reply({ error: 'access_unavailable' }, 503);
    return reply({ simulated: true, notices: await deps.notices.list(owner, choices, traceId) }, 200);
  }));

  app.all('/api/v1/mobile/notices/:eventId/receipt', route('POST', 'notices:receipt', async (c, owner, _decision, traceId, reply) => {
    const eventId = c.req.param('eventId') ?? '';
    if (!UUID.test(eventId)) return reply({ error: 'not_found' }, 404);
    if (!/^application\/json(\s*;|$)/i.test(c.req.header('content-type') ?? '')) return reply({ error: 'unsupported_media_type' }, 415);
    const declared = Number(c.req.header('content-length') ?? 0);
    if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) return reply({ error: 'invalid_request', fields: ['body'] }, 400);
    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return reply({ error: 'invalid_request', fields: ['body'] }, 400);
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = undefined; }
    if (!record(body) || Object.keys(body).length !== 1 || (body.outcome !== 'presented' && body.outcome !== 'permission_denied')) return reply({ error: 'invalid_request', fields: ['outcome'] }, 400);
    const result = await deps.notices.receipt(owner, eventId.toLowerCase(), body.outcome, traceId);
    if (result.status === 'not_found') return reply({ error: 'not_found' }, 404);
    if (result.status === 'conflict') return reply({ error: 'conflict' }, 409);
    return reply({ eventId: eventId.toLowerCase(), state: result.state, replayed: result.status === 'replayed' }, 200);
  }));
}
