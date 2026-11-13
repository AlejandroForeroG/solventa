import type { Context, Hono } from 'hono';
import type { ClaimReport } from '../../application/claim-report';
import type { ReportOwner } from '../../application/ports/claim-report';
import { isUuid } from '../../domain/claim-report';

export type ClaimReportHttpDependencies = {
  report: Pick<ClaimReport<ReadableStream<Uint8Array>>, 'create' | 'receive' | 'submit'>;
  authorize(input: { kind: 'mobile'; operation: 'claims:report'; token: string }): Promise<unknown>;
};
type Status = 200 | 201 | 400 | 401 | 403 | 404 | 405 | 409 | 415 | 422 | 503;
const MAX_BODY_BYTES = 32_768;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,128}$/;
const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function createClaimReportRoute(deps: Pick<ClaimReportHttpDependencies, 'authorize'>) {
  return (allow: string, work: (c: Context<{ Bindings: PolicyEnv }>, owner: ReportOwner, traceId: string, reply: Reply) => Promise<Response>) => async (c: Context<{ Bindings: PolicyEnv }>) => {
    const supplied = c.req.header('x-trace-id') ?? '';
    const traceId = isUuid(supplied) ? supplied.toLowerCase() : crypto.randomUUID();
    const reply: Reply = (body, status) => c.json({ ...body, traceId }, status, { 'cache-control': 'no-store', 'x-trace-id': traceId, 'x-content-type-options': 'nosniff' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!allow.split(', ').includes(c.req.method)) { c.header('Allow', allow); return reply({ error: 'method_not_allowed' }, 405); }
      const token = c.req.header('authorization')?.match(BEARER)?.[1];
      if (!token || token.length > 8192) return reply({ error: 'unauthorized' }, 401);
      const access = await Promise.race([deps.authorize({ kind: 'mobile', operation: 'claims:report', token }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('access_deadline')), 2000); })]);
      clearTimeout(timer);
      if (!record(access)) return reply({ error: 'access_unavailable' }, 503);
      if (access.allowed !== true) {
        if ((access.status === 401 && access.error === 'unauthorized') || (access.status === 403 && access.error === 'forbidden')) return reply({ error: access.error }, access.status);
        if (access.status === 400 && access.error === 'invalid_request') return reply({ error: 'invalid_request' }, 400);
        return reply({ error: 'access_unavailable' }, 503);
      }
      const actor = access.actor;
      if (!record(actor) || actor.kind !== 'user' || actor.channel !== 'mobile' || !Array.isArray(actor.operations) || !actor.operations.includes('claims:report')
        || !record(actor.principal) || !isUuid(actor.principal.clientId) || !isUuid(actor.principal.subjectToken)) return reply({ error: 'access_unavailable' }, 503);
      return await work(c, { clientId: actor.principal.clientId.toLowerCase(), subjectToken: actor.principal.subjectToken.toLowerCase() }, traceId, reply);
    } catch { return reply({ error: 'service_unavailable' }, 503); }
    finally { clearTimeout(timer); }
  };
}

export function mountClaimReport(app: Hono<{ Bindings: PolicyEnv }>, deps: ClaimReportHttpDependencies) {
  const route = createClaimReportRoute(deps);

  app.post('/api/v1/claims', route('POST', async (c, owner, traceId, reply) => {
    const key = c.req.header('idempotency-key') ?? '';
    if (!IDEMPOTENCY_KEY.test(key)) return reply({ error: 'invalid_request', fields: ['idempotencyKey'] }, 400);
    if (!/^application\/json(\s*;|$)/i.test(c.req.header('content-type') ?? '')) return reply({ error: 'unsupported_media_type' }, 415);
    const declared = Number(c.req.header('content-length') ?? 0);
    if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) return reply({ error: 'invalid_request', fields: ['body'] }, 400);
    const text = await c.req.text();
    let body: unknown;
    try { body = new TextEncoder().encode(text).length > MAX_BODY_BYTES ? undefined : JSON.parse(text); } catch { body = undefined; }
    const result = await deps.report.create(owner, body, key, traceId);
    switch (result.status) {
      case 'created': return reply(result.claim, 201);
      case 'replayed': return reply(result.claim, 200);
      case 'invalid': return reply({ error: 'invalid_request', fields: result.fields }, 400);
      case 'policy_not_found': return reply({ error: 'not_found' }, 404);
      case 'outside_coverage': return reply({ error: 'outside_coverage' }, 422);
      case 'idempotency_conflict': return reply({ error: 'idempotency_conflict' }, 409);
    }
  }));

  app.all('/api/v1/claims/:claimId/evidence/:fileId', route('PUT', async (c, owner, traceId, reply) => {
    const { claimId, fileId } = c.req.param();
    if (!isUuid(claimId) || !isUuid(fileId)) return reply({ error: 'not_found' }, 404);
    const length = c.req.header('content-length');
    const result = await deps.report.receive(owner, claimId.toLowerCase(), fileId.toLowerCase(),
      { contentType: c.req.header('content-type') ?? null, length: length !== undefined && /^\d+$/.test(length) ? Number(length) : null, body: c.req.raw.body }, traceId);
    switch (result.status) {
      case 'stored': case 'already_received': return reply({ fileId: fileId.toLowerCase(), state: 'verified' }, 200);
      case 'not_found': return reply({ error: 'not_found' }, 404);
      case 'claim_not_draft': return reply({ error: 'claim_not_draft' }, 409);
      case 'content_type_mismatch': return reply({ error: 'unsupported_media_type' }, 415);
      case 'size_mismatch': return reply({ error: 'invalid_request', fields: ['body'] }, 400);
      case 'checksum_mismatch': return reply({ error: 'checksum_mismatch' }, 422);
      case 'evidence_unavailable': return reply({ error: 'evidence_unavailable' }, 503);
    }
  }));

  app.all('/api/v1/claims/:claimId/submit', route('POST', async (c, owner, traceId, reply) => {
    const claimId = c.req.param('claimId');
    if (!isUuid(claimId)) return reply({ error: 'not_found' }, 404);
    const result = await deps.report.submit(owner, claimId.toLowerCase(), traceId);
    if (result.status === 'not_found') return reply({ error: 'not_found' }, 404);
    if (result.status === 'incomplete') return reply({ error: 'evidence_incomplete', missing: result.missing }, 409);
    return reply({ claimId: result.claimId, claimNumber: result.claimNumber, state: 'unassigned', submittedAt: result.submittedAt }, 200);
  }));
}

type Reply = (body: object, status: Status) => Response;
