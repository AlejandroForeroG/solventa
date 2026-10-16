import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { CreateQuote } from '../../application/create-quote';
import type { AccessCredential } from '../../application/ports/api-access';
import { safeCode } from '../safe-code';
import { canonicalTraceId } from '../trace-id';

const MAX_BODY_BYTES = 16 * 1024;

const MESSAGES = {
  'es-CO': { validation: 'Hay campos que no cumplen las reglas.', reused: 'La clave de idempotencia ya se usó con otra solicitud.', internal: 'Error interno.' },
  'en-US': { validation: 'Some fields do not meet the rules.', reused: 'The idempotency key was already used with a different request.', internal: 'Internal error.' }
} as const;

// Returns null as soon as the body is known to exceed the limit, without holding more than it allows.
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

// Identity's cookie names: no prefix locally, where the origin is plain HTTP.
const sessionCookie = (appEnv: string) => (appEnv === 'local' ? '' : '__Host-') + 'solventa-session';

function credentialFrom(c: Context, channel: 'partner' | 'web'): AccessCredential {
  if (channel === 'partner') {
    const token = c.req.header('authorization')?.match(/^Bearer ([A-Za-z0-9_.-]+)$/i)?.[1];
    return { kind: 'partner', token: token ?? '' };
  }
  const cookie = getCookie(c, sessionCookie(c.env.APP_ENV));
  return { kind: 'web', cookie: cookie ?? '', origin: c.req.header('origin') ?? '', requestOrigin: new URL(c.req.url).origin, method: c.req.method };
}

export function quotesHandler(quotes: CreateQuote, channel: 'partner' | 'web') {
  return async (c: Context) => {
    const traceId = canonicalTraceId(c.req.header('x-trace-id')) ?? crypto.randomUUID();
    const text = MESSAGES[c.req.header('accept-language')?.toLowerCase().startsWith('en') ? 'en-US' : 'es-CO'];
    const reply = (body: Record<string, unknown>, status: 200 | 201 | 400 | 401 | 403 | 409 | 500 | 503, extra: Record<string, string> = {}) =>
      c.json({ ...body, traceId }, status, { 'x-trace-id': traceId, 'cache-control': 'no-store', ...extra });
    try {
      // A browser session and a partner token never mix: a web request carrying Authorization is malformed.
      if (channel === 'web' && c.req.header('authorization') !== undefined) return reply({ error: 'invalid_request' }, 400);
      const raw = await readLimited(c.req.raw);
      let body: unknown = undefined;
      let malformed = raw === null;
      if (raw !== null) try { body = JSON.parse(raw); } catch { malformed = true; }

      const result = await quotes.execute({ credential: credentialFrom(c, channel), idempotencyKey: c.req.header('idempotency-key') ?? null, body: malformed ? undefined : body, traceId });
      if (result.status === 'denied') {
        const challenge: Record<string, string> = result.httpStatus === 401 && channel === 'partner' ? { 'www-authenticate': 'Bearer realm="solventa"' } : {};
        return reply({ error: result.error }, result.httpStatus, challenge);
      }
      if (result.status === 'invalid') return reply({ error: 'validation_error', message: text.validation, errors: result.errors }, 400);
      if (result.status === 'idempotency_conflict') return reply({ error: 'idempotency_key_reused', message: text.reused }, 409);
      const { traceId: _ignored, ...quote } = result.quote;
      return reply(quote, result.status === 'created' ? 201 : 200);
    } catch (error) {
      console.error(JSON.stringify({ event: 'quote_failed', traceId, code: safeCode(error) }));
      return reply({ error: 'internal_error', message: text.internal }, 500);
    }
  };
}
