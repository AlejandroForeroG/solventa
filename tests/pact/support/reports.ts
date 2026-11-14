import { createHttp } from '../../../backend/policy-claims-payments/src/adapters/inbound/http';
import { TimerDeadline } from '../../../backend/policy-claims-payments/src/adapters/outbound/timer-deadline';
import { Sha256ReportDigest } from '../../../backend/policy-claims-payments/src/adapters/outbound/sha256-report-digest';
import { Reports } from '../../../backend/policy-claims-payments/src/application/reports';
import { currentPeriod } from '../../../backend/policy-claims-payments/src/domain/report';
import { ApiAccess } from '../../../backend/identity-consent-ecosystem/src/application/api-access';
import { authorizeApiAccess } from '../../../backend/identity-consent-ecosystem/src/adapters/inbound/api-access-http';
import { MemoryDestination, MemoryReportStore } from '../../support/report-fakes';
import { ids, syntheticFacts } from '../../support/report-fixtures';

// The real Identity access handler decides each request; only the grant lookup and the report store are doubles.
export async function reportsWorld(origin: string, mode: 'empty' | 'seeded' | 'denied' | 'unavailable') {
  const cookie = 'synthetic-reports-session';
  const principal = { clientId: ids.operator, subjectToken: ids.policy(1) };
  const identity = { providerSubject: cookie, sessionReference: cookie, emailVerified: true };
  const grants = { find: async () => mode === 'denied' ? null : { expiresAt: new Date(Date.now() + 5000).toISOString() } };
  const authorization = {
    application: new ApiAccess({ find: async () => null }, { find: async () => principal, open: async () => principal, revoke: async () => {} }, undefined, undefined, undefined, undefined, grants),
    partner: null,
    web: { allowedOrigins: [origin], authenticate: async (value: string) => value === cookie ? { identity } : null },
    security: { deny: async () => {} }
  };
  const store = new MemoryReportStore(syntheticFacts());
  if (mode === 'unavailable') for (const method of ['facts', 'list', 'openDelivery'] as const) (store as unknown as Record<string, () => Promise<never>>)[method] = async () => { throw new Error('synthetic_reports_failure'); };
  const reports = new Reports(store, new Sha256ReportDigest(), { regulator: new MemoryDestination('regulator'), reinsurer: new MemoryDestination('reinsurer') }, { now: () => new Date() }, new TimerDeadline());
  if (mode === 'seeded') await reports.generate({ period: currentPeriod(new Date()), destination: 'regulator' }, { clientId: ids.operator, traceId: ids.delivery, expiresAt: new Date(Date.now() + 5000).toISOString() });
  const app = createHttp({ authorizeFinancialAccess: async () => null, denyResourceAccess: async () => null, finance: {} as never,
    reports: { reports, authorize: input => authorizeApiAccess(authorization, input) } });
  return { sessionCookie: cookie, policy: { fetch: (request: Request) => {
    const { pathname, search } = new URL(request.url);
    return Promise.resolve(app.request(new Request(origin + pathname + search, request), undefined, { APP_ENV: 'dev' } as PolicyEnv));
  } } };
}
