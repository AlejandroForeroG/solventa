import { createHttp } from '../../../backend/policy-claims-payments/src/adapters/inbound/http';
import { lifecycleFixture, lifecycleRecord } from '../../support/policy-lifecycle-fixture';
export const lifecyclePrincipal = { clientId: '01000000-0000-4000-8000-000000000001', subjectToken: '01000000-0000-4000-8000-000000000002' };
export const lifecycleIds = { policyId: '01000000-0000-4000-8000-000000000003', acceptanceId: '01000000-0000-4000-8000-000000000004', offerId: '01000000-0000-4000-8000-000000000005' };
export const lifecyclePactRecord = () => lifecycleRecord(lifecyclePrincipal, '2026-10-16T02:00:00.000Z', lifecycleIds);
export async function lifecyclePactWorld() {
  const fixture = lifecycleFixture([await lifecyclePactRecord()]);
  return createHttp({ finance: fixture.finance, denyResourceAccess: async () => ({ recorded: true }),
    authorizeFinancialAccess: async input => {
      const request = input as { cookie: string; operation: string; origin: string; requestOrigin: string; method: string };
      if (request.cookie !== 'lifecycle-owner') return { allowed: false, status: 401, error: 'unauthorized' };
      if (request.method === 'POST' && request.origin !== request.requestOrigin) return { allowed: false, status: 403, error: 'forbidden' };
      return { allowed: true, actor: { kind: 'user', channel: 'web', principal: lifecyclePrincipal, operations: [request.operation] } };
    } });
}
