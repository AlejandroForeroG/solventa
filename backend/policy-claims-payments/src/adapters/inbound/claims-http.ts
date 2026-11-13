import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { isClaimState } from '../../domain/claims';
import { isUuid } from '../../domain/claim-report';
import type { ClaimInbox } from '../../application/claim-inbox';
import { parseClaimDecision } from '../../domain/claim-decision';
import type { ClaimDecisions, ClaimDecisionActor } from '../../application/claim-decisions';
import type { CaseAccess, ClaimReview, ReviewOutcome } from '../../application/claim-review';
import type { ClaimQuery } from '../../application/ports/claims';

type Operation = 'claims:read' | 'claims:decide' | 'claims:respond';
type Method = 'GET' | 'POST' | 'PUT';
type ContextWithEnv = Context<{ Bindings: PolicyEnv }>;
type Status = 200 | 400 | 401 | 403 | 404 | 405 | 409 | 422 | 503;
type Reply = (body: object, status: Status) => Response;
type WebActor = ClaimDecisionActor & { subjectToken?: string };

export type ClaimsHttpDependencies = {
  inbox: Pick<ClaimInbox, 'list'>;
  decisions?: Pick<ClaimDecisions, 'decide'>;
  review?: Pick<ClaimReview<ReadableStream<Uint8Array>>, 'detail' | 'evidence' | 'directory' | 'review' | 'respond' | 'receive' | 'owned'>;
  download?(key: string, sha256: string, byteSize: number): Promise<ReadableStream<Uint8Array> | null>;
  authorize(input: { kind: 'web'; operation: Operation; traceId: string; method: Method; requestOrigin: string; origin: string; cookie: string }): Promise<unknown>;
};

const CLAIM_NUMBER = /^SIN-\d{4}-\d{5}$/;
const KEY = /^[A-Za-z0-9._-]{8,128}$/;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

async function readJson(request: Request): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')
    || Number(request.headers.get('content-length')) > 16_384 || !request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 16_384) { await reader.cancel(); return null; }
      body += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } catch { return null; }
  finally { reader.releaseLock(); }
}

export function claimQuery(params: URLSearchParams): ClaimQuery | null {
  const query: ClaimQuery = {};
  for (const [key, value] of params) {
    if (params.getAll(key).length !== 1) return null;
    if (key === 'state' && isClaimState(value)) query.state = value;
    else if (key === 'overdue' && value === 'true') query.overdue = true;
    else if (key === 'query' && (CLAIM_NUMBER.test(value) || isUuid(value))) query.query = CLAIM_NUMBER.test(value) ? value : value.toLowerCase();
    else if (key === 'before' && isUuid(value)) query.before = value.toLowerCase();
    else return null;
  }
  return query;
}

function actionReply(result: ReviewOutcome, reply: Reply) {
  if (result.status === 'ok') return reply({ actionId: result.actionId, state: result.state, replayed: result.replayed }, 200);
  if (result.status === 'not_found') return reply({ error: result.status }, 404);
  if (result.status === 'invalid_request') return reply({ error: result.status }, 400);
  return reply({ error: result.status }, 409);
}

export function mountClaims(app: Hono<{ Bindings: PolicyEnv }>, deps: ClaimsHttpDependencies) {
  const route = (method: Method, operation: Operation, work: (c: ContextWithEnv, actor: WebActor, reply: Reply) => Promise<Response>,
    allow: string = method) => async (c: ContextWithEnv) => {
    const incoming = c.req.header('x-trace-id');
    const traceId = isUuid(incoming) ? incoming.toLowerCase() : crypto.randomUUID();
    const headers = { 'cache-control': 'no-store', 'x-trace-id': traceId, 'x-content-type-options': 'nosniff' };
    const reply: Reply = (body, status) => c.json({ ...body, traceId }, status, headers);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (c.req.method !== method) { c.header('Allow', allow); return reply({ error: 'method_not_allowed' }, 405); }
      if (c.req.header('authorization') !== undefined) return reply({ error: 'invalid_request' }, 400);
      const requestUrl = new URL(c.req.url);
      const access = await Promise.race([deps.authorize({ kind: 'web', operation, traceId, method, requestOrigin: requestUrl.origin,
        origin: c.req.header('origin') ?? '', cookie: getCookie(c, (c.env.APP_ENV === 'local' ? '' : '__Host-') + 'solventa-session') ?? '' }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('access_deadline')), 2000); })]);
      clearTimeout(timer);
      if (!record(access)) return reply({ error: 'access_unavailable' }, 503);
      if (access.allowed !== true) {
        if ((access.status === 401 && access.error === 'unauthorized') || (access.status === 403 && access.error === 'forbidden')
          || (access.status === 400 && access.error === 'invalid_request')) return reply({ error: access.error }, access.status);
        return reply({ error: 'access_unavailable' }, 503);
      }
      const actor = access.actor;
      if (!record(actor) || actor.kind !== 'user' || actor.channel !== 'web' || !Array.isArray(actor.operations) || !actor.operations.includes(operation)
        || !record(actor.principal) || !isUuid(actor.principal.clientId)) return reply({ error: 'access_unavailable' }, 503);
      const subjectToken = isUuid(actor.principal.subjectToken) ? actor.principal.subjectToken.toLowerCase() : undefined;
      const expiresAt = typeof actor.authorizationExpiresAt === 'string' ? actor.authorizationExpiresAt : '';
      const remaining = Date.parse(expiresAt) - Date.now();
      if (operation === 'claims:respond' ? !subjectToken : !(remaining > 0) || remaining > 5500)
        return reply({ error: 'access_unavailable' }, 503);
      if (requestUrl.pathname !== '/api/v1/claims' && requestUrl.search) return reply({ error: 'invalid_request' }, 400);
      return await work(c, { clientId: actor.principal.clientId.toLowerCase(), traceId, subjectToken, expiresAt }, reply);
    } catch { return reply({ error: 'service_unavailable' }, 503); }
    finally {
      clearTimeout(timer);
      if (c.req.raw.body && !c.req.raw.bodyUsed) await c.req.raw.body.cancel().catch(() => {});
    }
  };

  app.all('/api/v1/claims', route('GET', 'claims:read', async (c, actor, reply) => {
    const query = claimQuery(new URL(c.req.url).searchParams);
    if (!query) return reply({ error: 'invalid_request' }, 400);
    return reply(await deps.inbox.list(query, { clientId: actor.clientId, traceId: actor.traceId, expiresAt: actor.expiresAt }), 200);
  }, 'GET, POST'));

  app.all('/api/v1/claims/:claimId/decisions', route('POST', 'claims:decide', async (c, actor, reply) => {
    if (!deps.decisions) return reply({ error: 'service_unavailable' }, 503);
    const claimId = c.req.param('claimId');
    const key = c.req.header('idempotency-key') ?? '';
    if (!isUuid(claimId) || !KEY.test(key)) return reply({ error: 'invalid_request' }, 400);
    const input = parseClaimDecision(await readJson(c.req.raw));
    if (!input) return reply({ error: 'invalid_request' }, 400);
    const result = await deps.decisions.decide(claimId.toLowerCase(), input, actor, key);
    if (result.status === 'ok') return reply({ decisionId: result.decisionId, state: result.state, replayed: result.replayed }, 200);
    return reply({ error: result.status }, result.status === 'not_found' ? 404 : 409);
  }));

  app.all('/api/v1/claims/experts', route('GET', 'claims:read', async (_c, _actor, reply) =>
    deps.review ? reply({ experts: deps.review.directory(), simulated: true }, 200) : reply({ error: 'service_unavailable' }, 503)));

  app.all('/api/v1/claims/:claimId/review', route('POST', 'claims:decide', async (c, actor, reply) => {
    if (!deps.review || !actor.subjectToken) return reply({ error: 'service_unavailable' }, 503);
    const claimId = c.req.param('claimId');
    const key = c.req.header('idempotency-key') ?? '';
    if (!isUuid(claimId) || !KEY.test(key)) return reply({ error: 'invalid_request' }, 400);
    return actionReply(await deps.review.review(claimId.toLowerCase(), actor, await readJson(c.req.raw), key), reply);
  }));

  app.all('/api/v1/claims/customer/cases', route('GET', 'claims:respond', async (_c, actor, reply) => {
    if (!deps.review || !actor.subjectToken) return reply({ error: 'service_unavailable' }, 503);
    return reply({ items: await deps.review.owned({ clientId: actor.clientId, subjectToken: actor.subjectToken }, actor.traceId) }, 200);
  }));

  for (const audience of ['analyst', 'customer'] as const) {
    const operation = audience === 'analyst' ? 'claims:read' : 'claims:respond';
    const prefix = audience === 'analyst' ? '/api/v1/claims/:claimId/case' : '/api/v1/claims/:claimId/customer';
    const asAccess = (actor: WebActor): CaseAccess | null => !actor.subjectToken ? null : audience === 'analyst'
      ? { kind: 'analyst', actor } : { kind: 'customer', actor: { clientId: actor.clientId, subjectToken: actor.subjectToken } };
    app.all(prefix, route('GET', operation, async (c, actor, reply) => {
      const claimId = c.req.param('claimId');
      const access = asAccess(actor);
      if (!deps.review || !access) return reply({ error: 'service_unavailable' }, 503);
      if (!isUuid(claimId)) return reply({ error: 'not_found' }, 404);
      const result = await deps.review.detail(claimId.toLowerCase(), access, actor.traceId);
      return result ? reply(result, 200) : reply({ error: 'not_found' }, 404);
    }));
    app.all(prefix + '/files/:fileId', route('GET', operation, async (c, actor, reply) => {
      const { claimId, fileId } = c.req.param();
      const access = asAccess(actor);
      if (!deps.review || !access) return reply({ error: 'service_unavailable' }, 503);
      if (!isUuid(claimId) || !isUuid(fileId)) return reply({ error: 'not_found' }, 404);
      const file = await deps.review.evidence(claimId.toLowerCase(), fileId.toLowerCase(), access, actor.traceId);
      if (!file) return reply({ error: 'not_found' }, 404);
      const body = await deps.download?.(file.key, file.sha256, file.byteSize);
      if (audience === 'analyst' && !(Date.parse(actor.expiresAt) > Date.now())) {
        await body?.cancel();
        return reply({ error: 'access_unavailable' }, 503);
      }
      return body ? new Response(body, { headers: { 'content-type': file.contentType, 'content-length': String(file.byteSize),
        'content-disposition': 'attachment', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-trace-id': actor.traceId } })
        : reply({ error: 'evidence_unavailable' }, 503);
    }));
  }

  const requirements = '/api/v1/claims/:claimId/requirements/:requirementId';
  app.all(requirements + '/response', route('POST', 'claims:respond', async (c, actor, reply) => {
    if (!deps.review || !actor.subjectToken) return reply({ error: 'service_unavailable' }, 503);
    const { claimId, requirementId } = c.req.param();
    const key = c.req.header('idempotency-key') ?? '';
    if (!isUuid(claimId) || !isUuid(requirementId) || !KEY.test(key)) return reply({ error: 'invalid_request' }, 400);
    return actionReply(await deps.review.respond(claimId.toLowerCase(), requirementId.toLowerCase(),
      { clientId: actor.clientId, subjectToken: actor.subjectToken }, await readJson(c.req.raw), key, actor.traceId), reply);
  }));

  app.all(requirements + '/files/:fileId', route('PUT', 'claims:respond', async (c, actor, reply) => {
    if (!deps.review || !actor.subjectToken) return reply({ error: 'service_unavailable' }, 503);
    const { claimId, requirementId, fileId } = c.req.param();
    if (!isUuid(claimId) || !isUuid(requirementId) || !isUuid(fileId)) return reply({ error: 'invalid_request' }, 400);
    const size = c.req.header('content-length') ?? '';
    const declaration = { fileId, byteSize: /^\d+$/.test(size) ? Number(size) : 0, contentType: c.req.header('content-type'),
      sha256: c.req.header('x-content-sha256') };
    const status = await deps.review.receive(claimId.toLowerCase(), requirementId.toLowerCase(), { clientId: actor.clientId, subjectToken: actor.subjectToken },
      declaration, c.req.raw.body, actor.traceId);
    if (status === 'verified') return reply({ fileId: fileId.toLowerCase(), state: status }, 200);
    return reply({ error: status === 'size_mismatch' ? 'invalid_request' : status }, status === 'not_found' ? 404 : status === 'conflict' ? 409 : status === 'invalid_request' || status === 'size_mismatch' ? 400
      : status === 'checksum_mismatch' ? 422 : 503);
  }));
}
