import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { FinancialActor, FinancialResult, PolicyListResult } from '../../domain/financial';
import { isDocumentKind } from '../../domain/policy-portal';
import type { DocumentFile, PolicyDetailResult, PolicyDocumentKind, PolicyDocumentResult } from '../../domain/policy-portal';
import { renderPdf } from './pdf';
import { mountClaims, type ClaimsHttpDependencies } from './claims-http';

import { mountAssistance, type AssistanceHttpDependencies } from './assistance-http';
import { mountAdvisor, type AdvisorHttpDependencies } from './advisor-http';

export type PolicyHttpDependencies = {
  advisor?: AdvisorHttpDependencies;
  assistance?: AssistanceHttpDependencies;
  authorizeFinancialAccess(input: unknown): Promise<unknown>;
  denyResourceAccess(input: unknown): Promise<unknown>;
  claims?: ClaimsHttpDependencies;
  finance: {
    changeLifecycle?(input: { actor: FinancialActor; policyId: string; action: import('../../domain/policy-lifecycle').LifecycleAction;
      replacementPolicyId: string | null; documentHash: string; reason: string; idempotencyKey: string; traceId: string }): Promise<FinancialResult>;
    listOwn(input: { actor: FinancialActor; traceId: string; includeEnded?: boolean }): Promise<PolicyListResult>;
    get(input: { actor: FinancialActor; policyId: string; traceId: string }): Promise<FinancialResult>;
    detail(input: { actor: FinancialActor; policyId: string; traceId: string }): Promise<PolicyDetailResult>;
    document(input: { actor: FinancialActor; policyId: string; documentId: PolicyDocumentKind; traceId: string }): Promise<PolicyDocumentResult>;
    getByAcceptance(input: { actor: FinancialActor; acceptanceId: string; traceId: string }): Promise<FinancialResult>;
    issue(input: { actor: FinancialActor; policyId: string; idempotencyKey: string; documentHash: string;
      challengeId: string; code: string; traceId: string }): Promise<FinancialResult>;
    issueLegacy(input: { actor: FinancialActor; policyId: string; idempotencyKey: string; documentHash: string; traceId: string }): Promise<FinancialResult>;
    charge(input: { actor: FinancialActor; policyId: string; idempotencyKey: string; documentHash: string; traceId: string }): Promise<FinancialResult>;
    beginSignatureChallenge(input: { actor: FinancialActor; policyId: string; documentHash: string; accepted: true; traceId: string }): Promise<FinancialResult>;
    cancelSignatureChallenge(input: { actor: FinancialActor; policyId: string; challengeId: string; traceId: string }): Promise<FinancialResult>;
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
  if (deps?.advisor) mountAdvisor(app, deps.advisor, smallBody);
  app.all('/api/v1/policies', listOwnHandler);
  // Web portal reads: static paths are registered before the :policyId routes.
  app.all('/api/v1/policies/issued', handler('policies:read', false, 'list'));
  app.all('/api/v1/policies/:policyId/detail', handler('policies:read', false, 'detail'));
  app.all('/api/v1/policies/:policyId/lifecycle', handler('policies:manage', false, 'lifecycle'));
  app.all('/api/v1/policies/:policyId/documents/:documentId', handler('policies:read', false, 'document'));
  app.all('/api/v1/policies/:policyId', handler('policies:read'));
  app.all('/api/v1/policies/by-acceptance/:acceptanceId/policy', handler('policies:read', true));
  app.all('/api/v2/policies/:policyId', handler('policies:read'));
  app.all('/api/v2/policies/by-acceptance/:acceptanceId/policy', handler('policies:read', true));
  app.all('/api/v1/policies/:policyId/issue', handler('policies:issue', false, 'legacyIssue'));
  app.all('/api/v2/policies/:policyId/issue', handler('policies:issue', false, 'issue'));
  app.all('/api/v2/policies/:policyId/charge', handler('policies:issue', false, 'charge'));
  app.all('/api/v2/policies/:policyId/signature-challenges', handler('policies:issue', false, 'challenge'));
  app.all('/api/v2/policies/:policyId/signature-challenges/:challengeId/cancel', handler('policies:issue', false, 'cancel'));
  // The native wallet lists the caller's own issued policies with a bearer token; the web routes below keep using the sealed cookie.
  async function listOwnHandler(c: import('hono').Context<{ Bindings: PolicyEnv }>) {
    const supplied = c.req.header('x-trace-id') ?? '';
    const traceId = UUID.test(supplied) ? supplied.toLowerCase() : crypto.randomUUID();
    const reply = (body: Record<string, unknown>, status: 200 | 400 | 401 | 403 | 404 | 405 | 409 | 503) => c.json({ ...body, traceId }, status,
      { 'x-trace-id': traceId, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (c.req.method !== 'GET') { c.header('Allow', 'GET'); return reply({ error: 'method_not_allowed' }, 405); }
      if (!deps) return reply({ error: 'financial_unavailable' }, 503);
      const token = c.req.header('authorization')?.match(/^Bearer ([A-Za-z0-9_.-]+)$/i)?.[1] ?? '';
      if (!token) return reply({ error: 'unauthorized' }, 401);
      const decision = await Promise.race([deps.authorizeFinancialAccess({ kind: 'mobile', operation: 'policies:read', token, traceId }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('access_deadline')), 2000); })]);
      if (!record(decision)) return reply({ error: 'access_unavailable' }, 503);
      if (decision.allowed !== true) {
        const { status, error } = decision;
        if ((status === 400 || status === 401 || status === 403 || status === 503) && typeof error === 'string'
          && ['invalid_request', 'unauthorized', 'forbidden', 'access_unavailable'].includes(error)) return reply({ error }, status);
        return reply({ error: 'access_unavailable' }, 503);
      }
      const actor = decision.actor;
      if (!record(actor) || actor.kind !== 'user' || actor.channel !== 'mobile' || !record(actor.principal)
        || !Array.isArray(actor.operations) || !actor.operations.includes('policies:read')
        || typeof actor.principal.clientId !== 'string' || !UUID.test(actor.principal.clientId)
        || typeof actor.principal.subjectToken !== 'string' || !UUID.test(actor.principal.subjectToken)) return reply({ error: 'access_unavailable' }, 503);
      const result = await deps.finance.listOwn({ actor: { clientId: actor.principal.clientId.toLowerCase(), subjectToken: actor.principal.subjectToken.toLowerCase() }, traceId, includeEnded: false });
      if (result.status === 'ok') return reply({ policies: result.policies, hasMore: result.hasMore }, 200);
      return reply({ error: result.error }, result.httpStatus);
    } catch { return reply({ error: 'financial_unavailable' }, 503); }
    finally { clearTimeout(timer); }
  }
  function handler(operation: 'policies:read' | 'policies:issue' | 'policies:manage', byAcceptance = false, action: 'lifecycle' | 'legacyIssue' | 'issue' | 'charge' | 'challenge' | 'cancel' | 'list' | 'detail' | 'document' = 'issue') {
    return async (c: import('hono').Context<{ Bindings: PolicyEnv }>) => {
      const supplied = c.req.header('x-trace-id') ?? '';
      const traceId = UUID.test(supplied) ? supplied.toLowerCase() : crypto.randomUUID();
      const reply = (body: Record<string, unknown>, status: 200 | 400 | 401 | 403 | 404 | 405 | 409 | 503) => c.json({ ...body, traceId }, status,
        { 'x-trace-id': traceId, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      const pdfReply = (file: DocumentFile) => new Response(renderPdf(file.title, file.lines), { status: 200, headers: { 'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${file.fileName}"`, 'x-trace-id': traceId, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
      // Same opaque response as an absent resource; only a missing import skips the resource-denial record.
      const refuse = async (result: Extract<FinancialResult, { status: 'denied' | 'unavailable' }>) => {
        if (result.status === 'denied' && result.error === 'policy_pending') return reply({ error: 'not_found' }, 404);
        if (result.httpStatus === 404 || result.httpStatus === 403) {
          let denialTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            const recorded = await Promise.race([deps?.denyResourceAccess({ operation, traceId }),
              new Promise<never>((_, reject) => { denialTimer = setTimeout(() => reject(new Error('denial_deadline')), 2000); })]);
            if (!record(recorded) || recorded.recorded !== true) return reply({ error: 'access_unavailable' }, 503);
          } catch { return reply({ error: 'access_unavailable' }, 503); }
          finally { clearTimeout(denialTimer); }
        }
        return reply({ error: result.error }, result.httpStatus);
      };
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
        if (action === 'list') {
          const listed = await deps.finance.listOwn({ actor: principal, traceId });
          return listed.status === 'ok' ? reply({ policies: listed.policies, hasMore: listed.hasMore }, 200) : refuse(listed);
        }
        const policyId = (c.req.param(byAcceptance ? 'acceptanceId' : 'policyId') ?? '').toLowerCase();
        if (!UUID.test(policyId)) return reply({ error: 'invalid_request' }, 400);
        if (action === 'detail') {
          const read = await deps.finance.detail({ actor: principal, policyId, traceId });
          return read.status === 'ok' ? reply({ ...read.detail }, 200) : refuse(read);
        }
        if (action === 'document') {
          const documentId = c.req.param('documentId') ?? '';
          if (!isDocumentKind(documentId)) return reply({ error: 'invalid_request' }, 400);
          const read = await deps.finance.document({ actor: principal, policyId, documentId, traceId });
          return read.status === 'ok' ? pdfReply(read.file) : refuse(read);
        }
        let result: FinancialResult;
        if (operation === 'policies:read') result = byAcceptance
          ? await deps.finance.getByAcceptance({ actor: principal, acceptanceId: policyId, traceId })
          : await deps.finance.get({ actor: principal, policyId, traceId });
        else {
          const body = await smallBody(c.req.raw);
          const idempotencyKey = c.req.header('idempotency-key') ?? '';
          if (action === 'lifecycle') {
            if (!record(body) || Object.keys(body).length !== 4 || typeof body.action !== 'string' || !['modified', 'renewed', 'cancelled'].includes(body.action)
              || typeof body.documentHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.documentHash) || typeof body.reason !== 'string'
              || !/^[a-z][a-z_]{2,63}$/.test(body.reason) || !(body.replacementPolicyId === null || typeof body.replacementPolicyId === 'string' && UUID.test(body.replacementPolicyId))
              || !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) return reply({ error: 'invalid_request' }, 400);
            if (!deps.finance.changeLifecycle) return reply({ error: 'financial_unavailable' }, 503);
            result = await deps.finance.changeLifecycle({ actor: principal, policyId, action: body.action as import('../../domain/policy-lifecycle').LifecycleAction,
              replacementPolicyId: typeof body.replacementPolicyId === 'string' ? body.replacementPolicyId.toLowerCase() : null,
              documentHash: body.documentHash, reason: body.reason, idempotencyKey, traceId });
          } else if (action === 'challenge') {
            if (!record(body) || Object.keys(body).length !== 2 || typeof body.documentHash !== 'string'
              || !/^[0-9a-f]{64}$/.test(body.documentHash) || body.accepted !== true) return reply({ error: 'invalid_request' }, 400);
            result = await deps.finance.beginSignatureChallenge({ actor: principal, policyId, documentHash: body.documentHash, accepted: true, traceId });
          } else if (action === 'cancel') {
            const challengeId = (c.req.param('challengeId') ?? '').toLowerCase();
            if (!UUID.test(challengeId) || !record(body) || Object.keys(body).length !== 0) return reply({ error: 'invalid_request' }, 400);
            result = await deps.finance.cancelSignatureChallenge({ actor: principal, policyId, challengeId, traceId });
          } else if (action === 'charge') {
            if (!record(body) || Object.keys(body).length !== 1 || typeof body.documentHash !== 'string'
              || !/^[0-9a-f]{64}$/.test(body.documentHash) || !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey))
              return reply({ error: 'invalid_request' }, 400);
            result = await deps.finance.charge({ actor: principal, policyId, idempotencyKey, documentHash: body.documentHash, traceId });
          } else if (action === 'legacyIssue') {
            if (!record(body) || Object.keys(body).length !== 1 || typeof body.documentHash !== 'string'
              || !/^[0-9a-f]{64}$/.test(body.documentHash) || !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey))
              return reply({ error: 'invalid_request' }, 400);
            result = await deps.finance.issueLegacy({ actor: principal, policyId, idempotencyKey, documentHash: body.documentHash, traceId });
          } else {
            if (!record(body) || Object.keys(body).length !== 3 || typeof body.documentHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.documentHash)
              || typeof body.challengeId !== 'string' || !UUID.test(body.challengeId) || typeof body.code !== 'string' || !/^[0-9]{6}$/.test(body.code)
              || !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) return reply({ error: 'invalid_request' }, 400);
            result = await deps.finance.issue({ actor: principal, policyId, idempotencyKey, documentHash: body.documentHash,
              challengeId: body.challengeId.toLowerCase(), code: body.code, traceId });
          }
        }
        if (result.status === 'ok') return reply({ ...result.policy, ...(result.payment ? { payment: result.payment } : {}),
          ...(result.challenge ? { challenge: result.challenge } : {}), replayed: result.replayed }, 200);
        return refuse(result);
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
  if (deps?.claims) mountClaims(app, deps.claims);
  if (deps?.assistance) mountAssistance(app, deps.assistance, smallBody);
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}
