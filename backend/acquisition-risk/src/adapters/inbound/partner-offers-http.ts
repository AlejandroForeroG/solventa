import type { Context, Hono } from 'hono';
import { DependencyTimings } from '../../application/dependency-timings';
import type { PartnerOffers } from '../../application/partner-offers';
import { safeCode } from '../safe-code';
import { canonicalTraceId } from '../trace-id';

const MAX_BODY_BYTES = 4 * 1024;
type Status = 200 | 201 | 400 | 401 | 403 | 405 | 409 | 429 | 500 | 503;

// Returns null as soon as the body is known to exceed the limit, without holding more than it allows.
async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return undefined;
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '', size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); return undefined; }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch { return undefined; }
}

export function mountPartnerOffers(app: Hono<{ Bindings: AcquisitionEnv }>, deps: { offers: PartnerOffers }) {
  app.all('/api/v1/partner/offers', async (c: Context) => {
    const startedAt = performance.now();
    const timings = new DependencyTimings({ now: () => new Date() });
    const traceId = canonicalTraceId(c.req.header('x-trace-id')) ?? crypto.randomUUID();
    let profileResult = 'unavailable';
    let offerStatus: string | null = null;
    const reply = (body: Record<string, unknown>, status: Status, extra: Record<string, string> = {}) => {
      if (status === 503) profileResult = 'unavailable';
      else if (status === 401 || status === 403) profileResult = 'denied';
      else if (status === 400 || status === 405) profileResult = 'invalid';
      return c.json({ ...body, traceId }, status, { 'x-trace-id': traceId, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
    };
    try {
      if (c.req.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
      // Only a partner token identifies the caller: a browser session is not a partner credential.
      const token = c.req.header('authorization')?.match(/^Bearer ([A-Za-z0-9_.-]+)$/i)?.[1] ?? '';
      const result = await deps.offers.create({ token, body: await readJson(c.req.raw), idempotencyKey: c.req.header('idempotency-key') ?? null, traceId, timings });
      profileResult = result.status;
      if (result.status === 'created' || result.status === 'replayed') {
        offerStatus = result.offer.status;
        return reply({ ...result.offer }, result.status === 'created' ? 201 : 200);
      }
      if (result.status === 'denied') {
        return reply({ error: result.error }, result.httpStatus, result.httpStatus === 401 ? { 'www-authenticate': 'Bearer realm="solventa"' } : result.httpStatus === 429 && result.retryAfter ? { 'retry-after': String(result.retryAfter) } : {});
      }
      if (result.status === 'invalid') return reply({ error: 'validation_error', errors: result.errors }, 400);
      if (result.status === 'idempotency_conflict') return reply({ error: 'idempotency_key_reused' }, 409);
      if (result.status === 'unavailable') return reply({ error: 'financial_unavailable' }, 503);
      return reply({ error: result.status }, 409);
    } catch (error) {
      console.error(JSON.stringify({ event: 'partner_offer_failed', traceId, code: safeCode(error) }));
      return reply({ error: 'internal_error' }, 500);
    } finally {
      console.log(JSON.stringify({ event: 'mortgage_offer_profiled', traceId, channel: 'partner', result: profileResult, offerStatus,
        latencyMs: Math.round((performance.now() - startedAt) * 10) / 10, ...timings.summary() }));
      if (c.req.raw.body && !c.req.raw.bodyUsed) await c.req.raw.body.cancel().catch(() => {});
    }
  });
}
