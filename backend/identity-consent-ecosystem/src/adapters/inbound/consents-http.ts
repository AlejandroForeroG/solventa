import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Consents } from '../../application/consents';
import type { Principal } from '../../application/authentication';
import { safeCode } from '../safe-code';
import type { AuthorizeApiAccess } from './api-access-http';

const MAX_BODY_BYTES = 4 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Status = 200 | 201 | 400 | 401 | 403 | 404 | 409 | 503;
type Handler = (c: Context<{ Bindings: IdentityEnv }>, principal: Principal, traceId: string, reply: (body: object, status: Status) => Response) => Promise<Response>;

async function readLimited(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function readJson(request: Request): Promise<unknown> {
  const raw = await readLimited(request);
  if (raw === null) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

// The sealed session cookie decides who the user is; an identifier in the body or the path never does.
export function mountConsents(app: Hono<{ Bindings: IdentityEnv }>, deps: { authorizeApiAccess: AuthorizeApiAccess; consents: Consents }) {
  const { consents } = deps;

  function route(operation: 'consents:read' | 'consents:write', handler: Handler) {
    return async (c: Context<{ Bindings: IdentityEnv }>) => {
      const supplied = c.req.header('X-Trace-Id') ?? '';
      const traceId = UUID.test(supplied) ? supplied : crypto.randomUUID();
      const reply = (body: object, status: Status) => c.json({ ...body, traceId }, status, { 'x-trace-id': traceId, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      try {
        if (c.req.header('Authorization') !== undefined) return reply({ error: 'invalid_request' }, 400);
        const decision = await deps.authorizeApiAccess({
          kind: 'web', operation, method: c.req.method, origin: c.req.header('Origin') ?? '',
          cookie: getCookie(c, (c.env.APP_ENV === 'local' ? '' : '__Host-') + 'solventa-session') ?? ''
        });
        if (!decision.allowed) return reply({ error: decision.error }, decision.status);
        if (decision.actor.kind !== 'user') return reply({ error: 'forbidden' }, 403);
        return await handler(c, decision.actor.principal, traceId, reply);
      } catch (error) {
        console.error(JSON.stringify({ event: 'consent_failed', traceId, code: safeCode(error) }));
        return reply({ error: 'access_unavailable' }, 503);
      }
    };
  }

  app.get('/api/v1/consents/terms', route('consents:read', async (_c, _principal, _traceId, reply) => reply(consents.terms(), 200)));

  app.get('/api/v1/consents', route('consents:read', async (_c, principal, _traceId, reply) => reply({ items: await consents.list(principal) }, 200)));

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
