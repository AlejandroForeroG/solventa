import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Principal } from '../../application/authentication';
import type { ApiOperation } from '../../application/api-access';
import { safeCode } from '../safe-code';
import type { AuthorizeApiAccess } from './api-access-http';

const MAX_BODY_BYTES = 4 * 1024;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type Status = 200 | 201 | 400 | 401 | 403 | 404 | 409 | 503;
export type Reply = (body: object, status: Status) => Response;
export type WebUserHandler = (c: Context<{ Bindings: IdentityEnv }>, principal: Principal, traceId: string, reply: Reply) => Promise<Response>;

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

export async function readJson(request: Request): Promise<unknown> {
  const raw = await readLimited(request);
  if (raw === null) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

// The sealed session cookie decides who the user is; an identifier in the body or the path never does.
export function webUserRoute<Operation extends ApiOperation>(authorizeApiAccess: AuthorizeApiAccess, events: { failed: string; bodyCancelFailed: string }) {
  return (operation: Operation, handler: WebUserHandler) => async (c: Context<{ Bindings: IdentityEnv }>) => {
    const supplied = c.req.header('X-Trace-Id') ?? '';
    const traceId = UUID.test(supplied) ? supplied.toLowerCase() : crypto.randomUUID();
    const reply: Reply = (body, status) => c.json({ ...body, traceId }, status, { 'x-trace-id': traceId, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    try {
      if (c.req.header('Authorization') !== undefined) return reply({ error: 'invalid_request' }, 400);
      const decision = await authorizeApiAccess({
        kind: 'web', operation, requestOrigin: new URL(c.req.url).origin, method: c.req.method, origin: c.req.header('Origin') ?? '', traceId,
        cookie: getCookie(c, (c.env.APP_ENV === 'local' ? '' : '__Host-') + 'solventa-session') ?? ''
      });
      if (!decision.allowed) return reply({ error: decision.error }, decision.status);
      if (decision.actor.kind !== 'user') return reply({ error: 'forbidden' }, 403);
      return await handler(c, decision.actor.principal, traceId, reply);
    } catch (error) {
      console.error(JSON.stringify({ event: events.failed, traceId, code: safeCode(error) }));
      return reply({ error: 'access_unavailable' }, 503);
    } finally {
      // Revocation and early denials do not consume a body; finish its transport before the binding responds.
      if (c.req.raw.body && !c.req.raw.bodyUsed) {
        await c.req.raw.body.cancel().catch(() => {
          console.error(JSON.stringify({ event: events.bodyCancelFailed, traceId, code: 'request_body_unavailable' }));
        });
      }
    }
  };
}
