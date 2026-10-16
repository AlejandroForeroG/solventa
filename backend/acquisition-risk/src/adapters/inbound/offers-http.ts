import type { Hono, Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { OfferService } from '../../application/offer-service';
import type { OfferAuthorization } from '../../domain/offer';
import type { OfferTerms } from '../../domain/offer';

export type OffersHttpDependencies = { offers: Pick<OfferService, 'create' | 'createFlight' | 'get' | 'accept'>; authorizeFinancialAccess(input: unknown): Promise<unknown>; denyResourceAccess(input: unknown): Promise<unknown> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function publicOffer(terms: OfferTerms) {
  const { clientId: _clientId, subjectToken: _subjectToken, ...view } = terms;
  return view;
}

async function bodyFrom(request: Request): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '') || Number(request.headers.get('content-length')) > 1024 || !request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '', size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) { await reader.cancel(); return null; }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch { return null; }
}

export function mountOffers(app: Hono<{ Bindings: AcquisitionEnv }>, deps: OffersHttpDependencies) {
  app.all('/api/v1/quotes/:quoteId/offers', handler('offers:create'));
  app.all('/api/v1/offers', handler('offers:create-flight'));
  app.all('/api/v1/offers/:offerId', handler('offers:read'));
  app.all('/api/v1/offers/:offerId/accept', handler('offers:accept'));
  function handler(operation: 'offers:create' | 'offers:create-flight' | 'offers:read' | 'offers:accept') {
    return async (c: Context<{ Bindings: AcquisitionEnv }>) => {
      const supplied = c.req.header('x-trace-id') ?? '';
      const traceId = UUID.test(supplied) ? supplied.toLowerCase() : crypto.randomUUID();
      const reply = (body: Record<string, unknown>, status: 200 | 201 | 202 | 400 | 401 | 403 | 404 | 405 | 409 | 503) => c.json({ ...body, traceId }, status,
        { 'x-trace-id': traceId, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const method = operation === 'offers:read' ? 'GET' : 'POST';
        if (c.req.method !== method) { c.header('Allow', method); return reply({ error: 'method_not_allowed' }, 405); }
        if (c.req.header('authorization') !== undefined) return reply({ error: 'invalid_request' }, 400);
        const decision = await Promise.race([deps.authorizeFinancialAccess({ kind: 'web', operation, traceId, method: c.req.method,
          cookie: getCookie(c, (c.env.APP_ENV === 'local' ? '' : '__Host-') + 'solventa-session') ?? '', origin: c.req.header('origin') ?? '' }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('access_deadline')), 2000); })]);
        if (!record(decision)) return reply({ error: 'access_unavailable' }, 503);
        if (decision.allowed !== true) {
          const { status, error } = decision;
          if ((status === 400 || status === 401 || status === 403 || status === 503) && typeof error === 'string' && ['invalid_request', 'unauthorized', 'forbidden', 'access_unavailable', 'consent_required'].includes(error)) return reply({ error }, status);
          return reply({ error: 'access_unavailable' }, 503);
        }
        const user = decision.actor;
        if (!record(user) || user.kind !== 'user' || user.channel !== 'web' || !record(user.principal)
          || !Array.isArray(user.operations) || !user.operations.includes(operation)
          || typeof user.principal.clientId !== 'string' || !UUID.test(user.principal.clientId)
          || typeof user.principal.subjectToken !== 'string' || !UUID.test(user.principal.subjectToken)) return reply({ error: 'access_unavailable' }, 503);
        const actor = { clientId: user.principal.clientId.toLowerCase(), subjectToken: user.principal.subjectToken.toLowerCase() };
        let authorization: OfferAuthorization | undefined;
        if (record(decision.consent) && typeof decision.consent.consentId === 'string' && /^CNS-\d{4}-\d{5,19}$/.test(decision.consent.consentId)
          && typeof decision.consent.textVersion === 'number' && Number.isSafeInteger(decision.consent.textVersion) && decision.consent.textVersion > 0
          && typeof decision.consent.expiresAt === 'string' && Number.isFinite(Date.parse(decision.consent.expiresAt))) {
          authorization = { consentId: decision.consent.consentId, textVersion: decision.consent.textVersion, expiresAt: decision.consent.expiresAt };
        }
        const offerId = (c.req.param('offerId') ?? '').toLowerCase();
        const quoteId = c.req.param('quoteId') ?? '';
        if ((operation === 'offers:read' || operation === 'offers:accept') && !UUID.test(offerId)) return reply({ error: 'invalid_request' }, 400);
        if (operation === 'offers:create' && !/^COT-\d{4}-\d{5}$/.test(quoteId)) return reply({ error: 'invalid_request' }, 400);
        if (operation === 'offers:read') {
          const result = await deps.offers.get({ actor, offerId });
          return result.status === 'found' ? reply(publicOffer(result.offer), 200) : failure(result.status);
        }
        const body = await bodyFrom(c.req.raw);
        const idempotencyKey = c.req.header('idempotency-key') ?? '';
        if (!record(body) || !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) return reply({ error: 'invalid_request' }, 400);
        if (operation === 'offers:create-flight') {
          if (Object.keys(body).length !== 2 || body.product !== 'flight_delay' || typeof body.flightReference !== 'string' || !UUID.test(body.flightReference)) return reply({ error: 'invalid_request' }, 400);
          const result = await deps.offers.createFlight({ actor, flightReference: body.flightReference.toLowerCase(), idempotencyKey, traceId });
          return result.status === 'created' || result.status === 'replayed' ? reply(publicOffer(result.offer), result.status === 'created' ? 201 : 200) : failure(result.status);
        }
        if (Object.keys(body).length !== 0) return reply({ error: 'invalid_request' }, 400);
        if (operation === 'offers:create') {
          if (!authorization) return reply({ error: 'access_unavailable' }, 503);
          const result = await deps.offers.create({ actor, quoteId, authorization, idempotencyKey, traceId });
          return result.status === 'created' || result.status === 'replayed' ? reply(publicOffer(result.offer), result.status === 'created' ? 201 : 200) : failure(result.status);
        }
        const result = await deps.offers.accept({ actor, offerId, authorization, idempotencyKey, traceId });
        return result.status === 'created' || result.status === 'replayed' ? reply({ ...result.acceptance }, result.status === 'created' ? 202 : 200) : failure(result.status);
      } catch { return reply({ error: 'financial_unavailable' }, 503); }
      finally {
        clearTimeout(timer);
        if (c.req.raw.body && !c.req.raw.bodyUsed) {
          await c.req.raw.body.cancel().catch(() => {
            console.error(JSON.stringify({ event: 'financial_body_cancel_failed', traceId, code: 'request_body_unavailable' }));
          });
        }
      }
      async function failure(status: string) {
        const code = status === 'denied' ? 403 : status === 'not_found' ? 404 : status === 'unavailable' ? 503 : status === 'invalid' ? 400 : 409;
        const error = status === 'denied' ? 'consent_required' : status === 'unavailable' ? 'financial_unavailable' : status === 'invalid' ? 'invalid_request' : status;
        if (code === 404 || code === 403) {
          let denialTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            const recorded = await Promise.race([deps.denyResourceAccess({ operation, traceId }),
              new Promise<never>((_, reject) => { denialTimer = setTimeout(() => reject(new Error('denial_deadline')), 2000); })]);
            if (!record(recorded) || recorded.recorded !== true) return reply({ error: 'access_unavailable' }, 503);
          } catch { return reply({ error: 'access_unavailable' }, 503); }
          finally { clearTimeout(denialTimer); }
        }
        return reply({ error }, code);
      }
    };
  }
}
