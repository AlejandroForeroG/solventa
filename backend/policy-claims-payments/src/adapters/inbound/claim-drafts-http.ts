import type { Hono } from 'hono';
import type { ClaimDrafts } from '../../application/claim-drafts';
import { isUuid } from '../../domain/claim-report';
import { createClaimReportRoute, type ClaimReportHttpDependencies } from './claim-report-http';

export type ClaimDraftHttpDependencies = Pick<ClaimReportHttpDependencies, 'authorize'> & { drafts: Pick<ClaimDrafts, 'get' | 'list' | 'sync' | 'evidence'> };

async function bodyOf(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '') || !request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let text = ''; let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16_384) { await reader.cancel(); return null; }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch { return null; }
  finally { reader.releaseLock(); }
}

export function mountClaimDrafts(app: Hono<{ Bindings: PolicyEnv }>, deps: ClaimDraftHttpDependencies): void {
  const route = createClaimReportRoute(deps);
  app.all('/api/v1/claim-drafts', route('GET', async (_c, owner, _trace, reply) => reply({ drafts: await deps.drafts.list(owner) }, 200)));
  app.all('/api/v1/claim-drafts/evidence', route('GET', async (c, owner, _trace, reply) => {
    const policyId = c.req.query('policyId');
    if (!isUuid(policyId)) return reply({ error: 'invalid_request' }, 400);
    return reply({ evidence: await deps.drafts.evidence(owner, policyId.toLowerCase()) }, 200);
  }));
  app.all('/api/v1/claim-drafts/:draftId', route('GET, PUT', async (c, owner, trace, reply) => {
    const id = c.req.param('draftId');
    if (!isUuid(id)) return reply({ error: 'not_found' }, 404);
    const draftId = id.toLowerCase();
    if (c.req.method === 'GET') {
      const draft = await deps.drafts.get(owner, draftId);
      return draft ? reply(draft, 200) : reply({ error: 'not_found' }, 404);
    }
    const result = await deps.drafts.sync(owner, draftId, await bodyOf(c.req.raw), trace);
    switch (result.status) {
      case 'confirmed': return reply(result, 200);
      case 'conflict': return reply(result, 409);
      case 'invalid': return reply({ error: 'invalid_request' }, 400);
      case 'not_found': case 'policy_unavailable': return reply({ error: 'not_found' }, 404);
      case 'outside_coverage': case 'evidence_unavailable': return reply({ error: result.status }, 422);
      case 'invalid_base': case 'idempotency_conflict': case 'limit_reached': return reply({ error: result.status }, 409);
    }
  }));
}
