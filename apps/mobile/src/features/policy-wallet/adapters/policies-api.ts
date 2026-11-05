import { AuthFailure } from '../../authentication/domain/session';
import { validateBaseUrl } from '../../authentication/adapters/solventa-session';
import { PolicyCacheFailure, maxCachedPolicies } from '../../policy-cache/domain/cached-policy';
import { minimizePolicy } from '../../policy-cache/application/protected-policy-cache';
import { PolicyApiFailure } from '../domain/wallet';
import type { AuthenticatedSession, PoliciesApi } from '../application/ports';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxBody = 64 * 1024;
const deadlineMs = 12_000;

function parse(raw: string): { policies: ReturnType<typeof minimizePolicy>[]; hasMore: boolean; traceId: string } {
  const data: unknown = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new PolicyApiFailure('invalid_response');
  const { policies, hasMore, traceId } = data as Record<string, unknown>;
  if (!Array.isArray(policies) || policies.length > maxCachedPolicies || typeof hasMore !== 'boolean' || typeof traceId !== 'string' || !uuid.test(traceId)) {
    throw new PolicyApiFailure('invalid_response');
  }
  // The list route returns issued policies only. Anything else is a contract violation: projecting it would drop its status and present unfinished or refunded coverage as active.
  return { policies: policies.map(policy => {
    if (!policy || typeof policy !== 'object' || (policy as Record<string, unknown>).status !== 'issued') throw new PolicyApiFailure('invalid_response');
    return minimizePolicy(policy);
  }), hasMore, traceId };
}

export function createPoliciesApi(baseUrl: string, session: AuthenticatedSession, request: typeof fetch = fetch): PoliciesApi {
  validateBaseUrl(baseUrl);
  return {
    list: () => session.execute(async token => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), deadlineMs);
      try {
        const response = await request(`${baseUrl}/api/v1/policies`, {
          method: 'GET', credentials: 'omit', signal: controller.signal, headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        });
        if (response.status === 401) throw new AuthFailure('unauthorized');
        if (response.status === 403) throw new AuthFailure('forbidden');
        if (!response.ok) throw new PolicyApiFailure('unavailable');
        if (!response.headers.get('content-type')?.includes('application/json')) throw new PolicyApiFailure('invalid_response');
        const raw = await response.text();
        if (raw.length > maxBody) throw new PolicyApiFailure('invalid_response');
        const { policies, hasMore } = parse(raw);
        return { policies, hasMore };
      } catch (error) {
        if (error instanceof AuthFailure || error instanceof PolicyApiFailure) throw error;
        // A malformed body is a contract violation, not an outage; a network error or timeout is retried later and the stored copy is shown.
        throw new PolicyApiFailure(error instanceof SyntaxError || error instanceof PolicyCacheFailure ? 'invalid_response' : 'unavailable');
      } finally { clearTimeout(timeout); }
    }),
  };
}
