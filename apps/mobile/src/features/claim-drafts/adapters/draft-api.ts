import { AuthFailure } from '../../authentication/domain/session';
import { validateBaseUrl } from '../../authentication/adapters/solventa-session';
import type { AuthenticatedSession } from '../../policy-wallet/application/ports';
import type { DraftApi } from '../application/ports';
import { DraftFailure, object, replyOf, uuid, versionOf, type DraftCommand } from '../domain/draft';

export function createDraftApi(baseUrl: string, session: AuthenticatedSession, request: typeof fetch = fetch): DraftApi {
  validateBaseUrl(baseUrl);
  const call = (path: string, command?: DraftCommand): Promise<unknown> => session.execute(async token => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await request(`${baseUrl}/api/v1/claim-drafts${path}`, {
        method: command ? 'PUT' : 'GET', credentials: 'omit', signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(command ? { 'Content-Type': 'application/json' } : {}) },
        ...(command ? { body: JSON.stringify(command) } : {}),
      });
      if (response.status === 401) throw new AuthFailure('unauthorized');
      if (response.status === 403) throw new AuthFailure('forbidden');
      if (response.status >= 500 || response.status === 429) throw new DraftFailure('unavailable');
      if (!response.headers.get('content-type')?.includes('application/json') || Number(response.headers.get('content-length')) > 262_144) throw new DraftFailure('invalid_response');
      const text = await response.text();
      if (new TextEncoder().encode(text).length > 262_144) throw new DraftFailure('invalid_response');
      const data: unknown = JSON.parse(text);
      if (!object(data) || !uuid(data.traceId)) throw new DraftFailure('invalid_response');
      if (!response.ok && !(response.status === 409 && data.status === 'conflict')) {
        const codes: Record<number, readonly string[]> = { 400: ['invalid_request'], 404: ['not_found'],
          409: ['invalid_base', 'idempotency_conflict', 'limit_reached'], 422: ['outside_coverage', 'evidence_unavailable'] };
        if (typeof data.error !== 'string' || !codes[response.status]?.includes(data.error)) throw new DraftFailure('invalid_response');
        throw new DraftFailure('rejected');
      }
      return data;
    } catch (error) {
      if (error instanceof AuthFailure || error instanceof DraftFailure) throw error;
      throw new DraftFailure(error instanceof SyntaxError ? 'invalid_response' : 'unavailable');
    } finally { clearTimeout(timer); }
  });
  return {
    async evidence(policyId) {
      if (!uuid(policyId)) throw new DraftFailure('rejected');
      const raw = await call(`/evidence?policyId=${policyId}`);
      if (!object(raw) || !Array.isArray(raw.evidence) || raw.evidence.length > 50) throw new DraftFailure('invalid_response');
      return raw.evidence.map(ref => {
        if (!object(ref) || !uuid(ref.claimId) || !uuid(ref.fileId) || typeof ref.contentType !== 'string'
          || !['image/jpeg', 'image/png', 'image/heic', 'video/mp4', 'video/quicktime'].includes(ref.contentType)
          || typeof ref.createdAt !== 'string' || !Number.isFinite(Date.parse(ref.createdAt))) throw new DraftFailure('invalid_response');
        return { claimId: ref.claimId, fileId: ref.fileId, contentType: ref.contentType, createdAt: ref.createdAt };
      });
    },
    async list() {
      const raw = await call('');
      if (!object(raw) || !Array.isArray(raw.drafts) || raw.drafts.length > 20) throw new DraftFailure('invalid_response');
      const drafts = raw.drafts.map(versionOf);
      if (new Set(drafts.map(d => d.draftId)).size !== drafts.length) throw new DraftFailure('invalid_response');
      return drafts;
    },
    async get(draftId) {
      if (!uuid(draftId)) throw new DraftFailure('rejected');
      const draft = versionOf(await call(`/${draftId}`));
      if (draft.draftId !== draftId) throw new DraftFailure('invalid_response');
      return draft;
    },
    async sync(draftId, command) {
      if (!uuid(draftId)) throw new DraftFailure('rejected');
      const reply = replyOf(await call(`/${draftId}`, command));
      if (reply.status === 'confirmed') {
        if (reply.draft.draftId !== draftId || reply.draft.content.policyId !== command.content.policyId || reply.draft.revision < command.baseRevision) throw new DraftFailure('invalid_response');
      } else if (reply.conflict.draftId !== draftId || reply.conflict.conflictId !== command.commandId || reply.conflict.local.policyId !== command.content.policyId
        || !reply.conflict.base || reply.conflict.base.revision !== command.baseRevision || reply.conflict.server.revision <= command.baseRevision) throw new DraftFailure('invalid_response');
      return reply;
    },
  };
}
