import { createHttp } from '../../../backend/policy-claims-payments/src/adapters/inbound/http';
import { ClaimInbox } from '../../../backend/policy-claims-payments/src/application/claim-inbox';
import type { OpenClaimRecord } from '../../../backend/policy-claims-payments/src/domain/claims';
import { ApiAccess } from '../../../backend/identity-consent-ecosystem/src/application/api-access';
import { authorizeApiAccess } from '../../../backend/identity-consent-ecosystem/src/adapters/inbound/api-access-http';
import examples from '../../../packages/contracts/examples/claims.json';

const DAY = 86_400_000;

export function claimsWorld(origin: string, state: 'granted' | 'empty' | 'denied' | 'unavailable') {
  const cookie = 'synthetic-claims-session';
  const principal = { clientId: examples.page.items[0].assigneeId as string, subjectToken: examples.page.items[0].policyId };
  const identity = { providerSubject: cookie, sessionReference: cookie, emailVerified: true };
  const now = Date.now();
  const records: OpenClaimRecord[] = examples.page.items.map(item => ({ id: item.claimId, claimNumber: item.claimNumber, policyId: item.policyId,
    state: item.state as OpenClaimRecord['state'], openedAt: new Date(now - item.ageDays * DAY), estimatedAmount: item.estimatedAmount, currency: item.currency,
    assigneeId: item.assigneeId, provided: item.evidence.provided, required: item.evidence.required, unverified: item.evidence.status === 'in_review' ? 1 : 0 }));
  const authorization = {
    application: new ApiAccess({ find: async () => null }, { find: async () => principal, open: async () => principal, revoke: async () => {} }, undefined,
      { find: async () => state === 'denied' ? null : { expiresAt: new Date(Date.now() + 5000).toISOString() } }),
    partner: null,
    web: { allowedOrigins: [origin], authenticate: async (value: string) => value === cookie ? { identity } : null },
    security: { deny: async () => {} }
  };
  const inbox = new ClaimInbox({
    list: async query => {
      if (state === 'unavailable') throw new Error('synthetic_claims_failure');
      const open = state === 'empty' ? [] : records.filter(record => (!query.state || record.state === query.state) && (!query.overdue || now - record.openedAt.getTime() >= 5 * DAY));
      return { records: open, next: null };
    }
  }, { now: () => new Date() });
  const app = createHttp({ authorizeFinancialAccess: async () => null, denyResourceAccess: async () => null, finance: {} as never,
    claims: { inbox, authorize: input => authorizeApiAccess(authorization, input) } });
  return { sessionCookie: cookie, policy: { fetch: (request: Request) => {
    const { pathname, search } = new URL(request.url);
    return Promise.resolve(app.request(new Request(origin + pathname + search, request), undefined, { APP_ENV: 'dev' } as PolicyEnv));
  } } };
}
