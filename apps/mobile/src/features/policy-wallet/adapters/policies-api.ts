import { AuthFailure } from '../../authentication/domain/session';
import { validateBaseUrl } from '../../authentication/adapters/solventa-session';
import { PolicyCacheFailure, maxCachedPolicies } from '../../policy-cache/domain/cached-policy';
import { minimizePolicy } from '../../policy-cache/application/protected-policy-cache';
import { PolicyApiFailure } from '../domain/wallet';
import type { AuthenticatedSession, PoliciesApi, PolicyPage } from '../application/ports';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxBody = 64 * 1024;
const deadlineMs = 12_000;

function parse(raw: string): PolicyPage {
  const data: unknown = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new PolicyApiFailure('invalid_response');
  const { policies, hasMore, traceId } = data as Record<string, unknown>;
  const nextCursor = (data as Record<string, unknown>).nextCursor ?? null;
  if (!Array.isArray(policies) || policies.length > maxCachedPolicies || typeof hasMore !== 'boolean' || typeof traceId !== 'string' || !uuid.test(traceId)) {
    throw new PolicyApiFailure('invalid_response');
  }
  // The list route returns issued policies only. Anything else is a contract violation: projecting it would drop its status and present unfinished or refunded coverage as active.
  const kept = policies.map(policy => {
    if (!policy || typeof policy !== 'object' || (policy as Record<string, unknown>).status !== 'issued') throw new PolicyApiFailure('invalid_response');
    return minimizePolicy(policy);
  });
  if (new Set(kept.map(policy => policy.policyId)).size !== kept.length
    || (hasMore ? typeof nextCursor !== 'string' || !uuid.test(nextCursor) || kept.at(-1)?.policyId !== nextCursor
      : nextCursor !== null)) throw new PolicyApiFailure('invalid_response');
  return { policies: kept, hasMore, nextCursor: typeof nextCursor === 'string' ? nextCursor : null };
}

export function createPoliciesApi(baseUrl: string, session: AuthenticatedSession, request: typeof fetch = fetch): PoliciesApi {
  validateBaseUrl(baseUrl);
  return {
    list: query => session.execute(async token => {
      if (query?.cursor && query.policyId || query?.cursor !== undefined && !uuid.test(query.cursor)
        || query?.policyId !== undefined && !uuid.test(query.policyId)) throw new PolicyApiFailure('invalid_response');
      const params = new URLSearchParams();
      if (query?.cursor !== undefined) params.set('cursor', query.cursor.toLowerCase());
      if (query?.policyId !== undefined) params.set('policyId', query.policyId.toLowerCase());
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), deadlineMs);
      try {
        const response = await request(`${baseUrl}/api/v1/policies${params.size ? '?' + params.toString() : ''}`, {
          method: 'GET', credentials: 'omit', signal: controller.signal, headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        });
        if (response.status === 401) throw new AuthFailure('unauthorized');
        if (response.status === 403) throw new AuthFailure('forbidden');
        if (response.status === 409) throw new PolicyApiFailure('integrity');
        // Only a server or rate-limit failure is an outage. Any other rejection (400, 404, 405) means the client and the contract disagree.
        if (response.status >= 500 || response.status === 429) throw new PolicyApiFailure('unavailable');
        if (!response.ok) throw new PolicyApiFailure('invalid_response');
        if (!response.headers.get('content-type')?.includes('application/json')) throw new PolicyApiFailure('invalid_response');
        const raw = await response.text();
        if (raw.length > maxBody) throw new PolicyApiFailure('invalid_response');
        const page = parse(raw);
        if (query?.cursor && page.nextCursor === query.cursor.toLowerCase()
          || query?.policyId && (page.hasMore || page.policies.some(policy => policy.policyId !== query.policyId?.toLowerCase()))) throw new PolicyApiFailure('invalid_response');
        return page;
      } catch (error) {
        if (error instanceof AuthFailure || error instanceof PolicyApiFailure) throw error;
        // A malformed body is a contract violation, not an outage; a network error or timeout is retried later and the stored copy is shown.
        throw new PolicyApiFailure(error instanceof SyntaxError || error instanceof PolicyCacheFailure ? 'invalid_response' : 'unavailable');
      } finally { clearTimeout(timeout); }
    }),
  };
}
