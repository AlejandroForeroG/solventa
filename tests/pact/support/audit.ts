import { Hono } from 'hono';
import { mountAuditDecisions } from '../../../backend/acquisition-risk/src/adapters/inbound/audit-decisions-http';
import { AuditDecisions } from '../../../backend/acquisition-risk/src/application/audit-decisions';
import { ApiAccess } from '../../../backend/identity-consent-ecosystem/src/application/api-access';
import { authorizeApiAccess } from '../../../backend/identity-consent-ecosystem/src/adapters/inbound/api-access-http';
import { auditIds, historicalMortgage, historicalMockMortgage } from '../../support/audit-fixtures';

export function auditWorld(origin: string, state: 'granted' | 'legacy' | 'recovered' | 'denied' | 'unavailable') {
  const cookie = 'synthetic-audit-session';
  const principal = { clientId: auditIds.client, subjectToken: auditIds.subject };
  const identity = { providerSubject: cookie, sessionReference: cookie, emailVerified: true };
  const app = new Hono<{ Bindings: AcquisitionEnv }>();
  const stored = state === 'recovered' ? historicalMockMortgage() : historicalMortgage();
  if (state === 'legacy') {
    const snapshot = JSON.parse(JSON.stringify(stored.snapshot)); delete snapshot.inputs.identityVerified;
    stored.snapshot = snapshot;
  }
  const authorization = {
    application: new ApiAccess({ find: async () => null }, { find: async () => principal, open: async () => principal, revoke: async () => {} },
      { find: async () => state === 'denied' ? null : { expiresAt: new Date(Date.now() + 5000).toISOString() } }),
    partner: null,
    web: { allowedOrigins: [origin], authenticate: async (value: string) => value === cookie ? { identity } : null },
    security: { deny: async () => {} }
  };
  mountAuditDecisions(app, { authorize: input => authorizeApiAccess(authorization, input), decisions: new AuditDecisions({
    list: async () => { if (state === 'unavailable') throw new Error('synthetic_audit_failure'); return { items: [stored], next: null }; },
    get: async id => id === stored.decisionId ? stored : null
  }, { now: () => new Date() }) });
  return { sessionCookie: cookie, acquisition: { fetch: (request: Request) => {
    const { pathname, search } = new URL(request.url);
    return Promise.resolve(app.request(new Request(origin + pathname + search, request), undefined, { APP_ENV: 'dev' } as AcquisitionEnv));
  } } };
}
