import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { FinancialActor, FinancialResult } from '../../domain/financial';

export type PolicyHttpDependencies = {
  authorizeFinancialAccess(input: unknown): Promise<unknown>;
  denyResourceAccess(input: unknown): Promise<unknown>;
  finance: {
    get(input: { actor: FinancialActor; policyId: string; traceId: string }): Promise<FinancialResult>;
    getByAcceptance(input: { actor: FinancialActor; acceptanceId: string; traceId: string }): Promise<FinancialResult>;
    issue(input: { actor: FinancialActor; policyId: string; idempotencyKey: string; documentHash: string; traceId: string }): Promise<FinancialResult>;
  };
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
async function smallBody(request: Request): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return null;
  if (Number(request.headers.get('content-length')) > 1024 || !request.body) return null;
  const reader = request.body.getReader();
  let text = '';
  let size = 0;
  const decoder = new TextDecoder();
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

export function createHttp(deps?: PolicyHttpDependencies) {
  const app = new Hono<{ Bindings: PolicyEnv }>();
  app.get('/health', (c) => c.json({ service: 'policy-claims-payments', status: 'alive' }));
  app.all('/api/v1/policies/:policyId', handler('policies:read'));
  app.all('/api/v1/policies/by-acceptance/:acceptanceId/policy', handler('policies:read', true));
  app.all('/api/v1/policies/:policyId/issue', handler('policies:issue'));
  function handler(operation: 'policies:read' | 'policies:issue', byAcceptance = false) {
    return async (c: import('hono').Context<{ Bindings: PolicyEnv }>) => {
      const supplied = c.req.header('x-trace-id') ?? '';
      const traceId = UUID.test(supplied) ? supplied.toLowerCase() : crypto.randomUUID();
      const reply = (body: Record<string, unknown>, status: 200 | 400 | 401 | 403 | 404 | 405 | 409 | 503) => c.json({ ...body, traceId }, status,
        { 'x-trace-id': traceId, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const method = operation === 'policies:read' ? 'GET' : 'POST';
        if (c.req.method !== method) { c.header('Allow', method); return reply({ error: 'method_not_allowed' }, 405); }
        if (c.req.header('authorization') !== undefined) return reply({ error: 'invalid_request' }, 400);
        if (!deps) return reply({ error: 'financial_unavailable' }, 503);
        const decision = await Promise.race([deps.authorizeFinancialAccess({ kind: 'web', operation, traceId, method: c.req.method, requestOrigin: new URL(c.req.url).origin,
          cookie: getCookie(c, (c.env.APP_ENV === 'local' ? '' : '__Host-') + 'solventa-session') ?? '', origin: c.req.header('origin') ?? '' }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('access_deadline')), 2000); })]);
        if (!record(decision)) return reply({ error: 'access_unavailable' }, 503);
        if (decision.allowed !== true) {
          const status = decision.status;
          const error = decision.error;
          if ((status === 400 || status === 401 || status === 403 || status === 503) && typeof error === 'string' && ['invalid_request', 'unauthorized', 'forbidden', 'access_unavailable', 'consent_required'].includes(error)) return reply({ error }, status);
          return reply({ error: 'access_unavailable' }, 503);
        }
        const actor = decision.actor;
        if (!record(actor) || actor.kind !== 'user' || actor.channel !== 'web' || !record(actor.principal)
          || !Array.isArray(actor.operations) || !actor.operations.includes(operation)
          || typeof actor.principal.clientId !== 'string' || !UUID.test(actor.principal.clientId)
          || typeof actor.principal.subjectToken !== 'string' || !UUID.test(actor.principal.subjectToken)) return reply({ error: 'access_unavailable' }, 503);
        const principal = { clientId: actor.principal.clientId.toLowerCase(), subjectToken: actor.principal.subjectToken.toLowerCase() };
        const policyId = (c.req.param(byAcceptance ? 'acceptanceId' : 'policyId') ?? '').toLowerCase();
        if (!UUID.test(policyId)) return reply({ error: 'invalid_request' }, 400);
        let result: FinancialResult;
        if (operation === 'policies:read') result = byAcceptance
          ? await deps.finance.getByAcceptance({ actor: principal, acceptanceId: policyId, traceId })
          : await deps.finance.get({ actor: principal, policyId, traceId });
        else {
          const body = await smallBody(c.req.raw);
          const idempotencyKey = c.req.header('idempotency-key') ?? '';
          if (!record(body) || Object.keys(body).length !== 1 || typeof body.documentHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.documentHash)
            || !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) return reply({ error: 'invalid_request' }, 400);
          result = await deps.finance.issue({ actor: principal, policyId, idempotencyKey, documentHash: body.documentHash, traceId });
        }
        if (result.status === 'ok') return reply({ ...result.policy, replayed: result.replayed }, 200);
        // Same opaque response as an absent resource; only a missing import skips the resource-denial record.
        if (result.status === 'denied' && result.error === 'policy_pending') return reply({ error: 'not_found' }, 404);
        if (result.httpStatus === 404 || result.httpStatus === 403) {
          let denialTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            const recorded = await Promise.race([deps.denyResourceAccess({ operation, traceId }),
              new Promise<never>((_, reject) => { denialTimer = setTimeout(() => reject(new Error('denial_deadline')), 2000); })]);
            if (!record(recorded) || recorded.recorded !== true) return reply({ error: 'access_unavailable' }, 503);
          } catch { return reply({ error: 'access_unavailable' }, 503); }
          finally { clearTimeout(denialTimer); }
        }
        return reply({ error: result.error }, result.httpStatus);
      } catch { return reply({ error: 'financial_unavailable' }, 503); }
      finally {
        clearTimeout(timer);
        if (c.req.raw.body && !c.req.raw.bodyUsed) {
          await c.req.raw.body.cancel().catch(() => {
            console.error(JSON.stringify({ event: 'financial_body_cancel_failed', traceId, code: 'request_body_unavailable' }));
          });
        }
      }
    };
  }
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}
