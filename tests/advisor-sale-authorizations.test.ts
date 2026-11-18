import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ApiAccess } from '../backend/identity-consent-ecosystem/src/application/api-access';
import { AdvisorSaleAuthorizations } from '../backend/identity-consent-ecosystem/src/application/advisor-sale-authorizations';
import { authorizeAdvisorSaleAccess } from '../backend/identity-consent-ecosystem/src/application/advisor-sale-access';
import { RISK_SCOPES } from '../backend/identity-consent-ecosystem/src/application/partner-offer-access';
import { MemoryAdvisorSaleAuthorizations } from './support/advisor-sale-fakes';
import { createHttp } from '../backend/identity-consent-ecosystem/src/adapters/inbound/http';
import type { ConsentDecision } from '../backend/identity-consent-ecosystem/src/application/consents';

const customer = { clientId: randomUUID(), subjectToken: randomUUID() };
const otherCustomer = { clientId: randomUUID(), subjectToken: randomUUID() };
const advisor = { clientId: randomUUID(), subjectToken: randomUUID(), reference: randomUUID() };
const otherAdvisor = { clientId: randomUUID(), subjectToken: randomUUID(), reference: randomUUID() };
const advisors = new Map([[advisor.reference, advisor.clientId], [otherAdvisor.reference, otherAdvisor.clientId]]);
const start = new Date('2026-11-09T12:00:00.000Z');

function fixture() {
  let now = start;
  const store = new MemoryAdvisorSaleAuthorizations(advisors, () => now);
  const service = new AdvisorSaleAuthorizations({ store, now: () => now });
  return { store, service, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

test('a customer authorizes a named advisor for one day by default and the view never exposes internal identifiers', async () => {
  const { service } = fixture();
  const result = await service.grant({ principal: customer, body: { advisorReference: advisor.reference }, traceId: randomUUID() });
  assert.equal(result.status, 'created');
  if (result.status !== 'created') return;
  assert.equal(result.authorization.status, 'active');
  assert.equal(result.authorization.expiresAt, '2026-11-10T12:00:00.000Z');
  assert.deepEqual(Object.keys(result.authorization).sort(), ['advisorReference', 'authorizationId', 'expiresAt', 'grantedAt', 'operation', 'revokedAt', 'status']);
});

test('the grant body accepts only an advisor reference and a validity from 1 to 7 days', async () => {
  const { service } = fixture();
  const reference = advisor.reference;
  for (const body of [undefined, null, [], {}, { advisorReference: 'nope' }, { advisorReference: reference, clientId: customer.clientId }, { advisorReference: reference, validityDays: 0 },
    { advisorReference: reference, validityDays: 8 }, { advisorReference: reference, validityDays: 1.5 }, { advisorReference: reference, validityDays: '2' }]) {
    assert.equal((await service.grant({ principal: customer, body, traceId: randomUUID() })).status, 'invalid', JSON.stringify(body));
  }
  assert.equal((await service.grant({ principal: customer, body: { advisorReference: reference, validityDays: 7 }, traceId: randomUUID() })).status, 'created');
  assert.equal((await service.grant({ principal: customer, body: { advisorReference: randomUUID() }, traceId: randomUUID() })).status, 'advisor_not_found');
});

test('an advisor cannot be authorized by themselves', async () => {
  const { service } = fixture();
  assert.equal((await service.grant({ principal: { clientId: advisor.clientId, subjectToken: advisor.subjectToken }, body: { advisorReference: advisor.reference }, traceId: randomUUID() })).status, 'advisor_not_found');
});

test('a customer lists and revokes only their own authorizations, and a revoked or expired one is reported as such', async () => {
  const { service, advance } = fixture();
  const first = await service.grant({ principal: customer, body: { advisorReference: advisor.reference }, traceId: randomUUID() });
  await service.grant({ principal: otherCustomer, body: { advisorReference: advisor.reference }, traceId: randomUUID() });
  if (first.status !== 'created') throw Error('unreachable');
  const id = first.authorization.authorizationId;
  assert.deepEqual((await service.list(customer)).items.map(item => item.authorizationId), [id]);
  assert.equal((await service.revoke({ principal: otherCustomer, authorizationId: id, traceId: randomUUID() })).status, 'not_found');
  const revoked = await service.revoke({ principal: customer, authorizationId: id, traceId: randomUUID() });
  assert.equal(revoked.status === 'revoked' && revoked.authorization.status, 'revoked');
  assert.equal((await service.revoke({ principal: customer, authorizationId: id, traceId: randomUUID() })).status, 'revoked', 'revoking twice answers the same record');
  assert.equal((await service.revoke({ principal: customer, authorizationId: 'not-a-uuid', traceId: randomUUID() })).status, 'invalid');
  const second = await service.grant({ principal: customer, body: { advisorReference: advisor.reference }, traceId: randomUUID() });
  if (second.status !== 'created') throw Error('unreachable');
  advance(2 * 86400000);
  assert.equal((await service.list(customer)).items[0].status, 'expired');
  assert.equal((await service.revoke({ principal: customer, authorizationId: second.authorization.authorizationId, traceId: randomUUID() })).status, 'not_active');
});

const noAuthentication = { authenticate: async () => null, sessions: () => { throw Error('unused'); } } as never;
function http(actor: unknown, service = fixture().service) {
  const seen: unknown[] = [];
  const app = createHttp({ authentication: noAuthentication, advisorSaleAuthorizations: service,
    authorizeApiAccess: async (input: unknown) => { seen.push(input); return actor === null ? { allowed: false, error: 'unauthorized', status: 401 } : { allowed: true, actor }; } } as never);
  const call = (path: string, init: RequestInit = {}) => app.request('http://localhost' + path, { ...init, headers: { 'content-type': 'application/json', ...init.headers } }, { APP_ENV: 'local' } as never);
  return { call, seen };
}
const userActor = { kind: 'user', channel: 'web', principal: customer, operations: [] };

test('the web routes authorize the session for the exact operation and never read the customer from the body', async () => {
  const { call, seen } = http(userActor);
  const created = await call('/api/v1/me/advisor-sale-authorizations', { method: 'POST', body: JSON.stringify({ advisorReference: advisor.reference }) });
  assert.equal(created.status, 201);
  const body = await created.json() as { authorizationId: string };
  assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.equal((await call('/api/v1/me/advisor-sale-authorizations')).status, 200);
  assert.deepEqual((seen as { operation: string; kind: string }[]).map(input => [input.kind, input.operation]), [['web', 'advisor-sale-authorizations:write'], ['web', 'advisor-sale-authorizations:read']]);
  assert.equal((await call(`/api/v1/me/advisor-sale-authorizations/${body.authorizationId}/revoke`, { method: 'POST' })).status, 200);
  const foreign = await call('/api/v1/me/advisor-sale-authorizations', { method: 'POST', body: JSON.stringify({ advisorReference: advisor.reference, clientId: otherCustomer.clientId }) });
  assert.equal(foreign.status, 400);
});

test('the web routes reject partner actors, missing sessions, unknown advisors and unknown authorizations', async () => {
  assert.equal((await http({ kind: 'partner', partnerId: randomUUID(), credentialId: randomUUID(), scopes: [] }).call('/api/v1/me/advisor-sale-authorizations')).status, 403);
  assert.equal((await http(null).call('/api/v1/me/advisor-sale-authorizations')).status, 401);
  assert.equal((await http(userActor).call('/api/v1/me/advisor-sale-authorizations', { method: 'POST', body: JSON.stringify({ advisorReference: randomUUID() }) })).status, 404);
  assert.equal((await http(userActor).call(`/api/v1/me/advisor-sale-authorizations/${randomUUID()}/revoke`, { method: 'POST' })).status, 404);
  assert.equal((await http(userActor).call('/api/v1/me/advisor-sale-authorizations/not-a-uuid/revoke', { method: 'POST' })).status, 400);
});

test('operation policy: only a web customer manages advisor sale authorizations', async () => {
  const sessions = { find: async () => ({ clientId: customer.clientId, subjectToken: customer.subjectToken }) } as never;
  const identity = { emailVerified: true, providerSubject: 'user_1', sessionReference: 'session_1' } as never;
  const operations = ['advisor-sale-authorizations:read', 'advisor-sale-authorizations:write'];
  const access = new ApiAccess({ find: async () => ({ partnerId: randomUUID(), credentialId: randomUUID(), scopes: operations }) }, sessions);
  const partnerIdentity = { issuer: 'https://synthetic.authkit.app', organizationId: 'org_synthetic', applicationId: 'client_synthetic', scopes: operations };
  for (const operation of operations) {
    assert.deepEqual(await access.partner(partnerIdentity, operation), { allowed: false, error: 'forbidden', status: 403 }, `partner cannot ${operation}`);
    assert.equal((await access.webUser(identity, operation)).allowed, true, `web customer can ${operation}`);
    assert.equal((await access.mobileUser(identity, operation)).allowed, false, `native customer cannot ${operation}`);
  }
});

const grantedConsent = (overrides: Partial<{ consentId: string; textVersion: number; expiresAt: string }> = {}): ConsentDecision =>
  ({ allowed: true, consent: { consentId: 'CNS-2026-00001', textVersion: 2, expiresAt: '2027-01-01T00:00:00.000Z', ...overrides } }) as ConsentDecision;
const allGranted = (): ConsentDecision[] => RISK_SCOPES.map(() => grantedConsent());

async function accessFixture(options: { advisor?: typeof advisor; actor?: unknown; consents?: ConsentDecision[] | (() => Promise<ConsentDecision[]>); denyFails?: boolean; authorizedFor?: typeof customer } = {}) {
  const { service, store, advance } = fixture();
  const granted = await service.grant({ principal: options.authorizedFor ?? customer, body: { advisorReference: advisor.reference }, traceId: randomUUID() });
  if (granted.status !== 'created') throw Error('unreachable');
  const actingAdvisor = options.advisor ?? advisor;
  const denials: unknown[] = []; const authorizations: unknown[] = []; let consentReads = 0;
  const run = (input: unknown) => authorizeAdvisorSaleAccess({
    authorize: async request => { authorizations.push(request); return options.actor === null ? { allowed: false, error: 'unauthorized', status: 401 }
      : { allowed: true, actor: options.actor ?? { kind: 'user', channel: 'web', principal: { clientId: actingAdvisor.clientId, subjectToken: actingAdvisor.subjectToken }, operations: ['policies:manage-delegated'],
        advisorPermission: { reference: actingAdvisor.reference, expiresAt: new Date(Date.now() + 4000).toISOString() } } } as never; },
    advisors: { eligible: async () => null },
    authorizations: store,
    verifyConsents: async request => { consentReads++; assert.equal(request.subjectToken, (options.authorizedFor ?? customer).subjectToken); assert.deepEqual([...request.scopes], [...RISK_SCOPES]); assert.equal(request.purposeCode, 'risk_profiling');
      return typeof options.consents === 'function' ? options.consents() : options.consents ?? allGranted(); },
    security: { deny: async (denial: unknown) => { if (options.denyFails) throw Error('audit down'); denials.push(denial); } } as never
  }, input);
  return { run, id: granted.authorization.authorizationId, store, advance, denials, authorizations, reads: () => consentReads };
}

const webInput = (authorizationId: string) => ({ kind: 'web', cookie: 'session', authorizationId, traceId: randomUUID() });

test('an authorized advisor receives the customer behind the authorization and the fresh consent, never the other way round', async () => {
  const f = await accessFixture();
  const decision = await f.run(webInput(f.id));
  assert.deepEqual(decision, { allowed: true, advisorReference: advisor.reference, customer, authorizationExpiresAt: '2026-11-10T12:00:00.000Z',
    consent: { consentId: 'CNS-2026-00001', textVersion: 2, expiresAt: '2027-01-01T00:00:00.000Z' } });
  assert.equal((f.authorizations[0] as { operation: string }).operation, 'policies:manage-delegated');
  assert.equal('authorizationId' in (f.authorizations[0] as object), false, 'the authorization is not forwarded to session verification');
});

test('input that is not a web request with a UUID authorization is invalid before any authentication or lookup', async () => {
  const f = await accessFixture();
  for (const input of [null, {}, { kind: 'web' }, { authorizationId: f.id }, { kind: 'partner', authorizationId: f.id }, { kind: 'web', authorizationId: 'nope' }, [], { kind: 'web', authorizationId: 1 }]) {
    assert.deepEqual(await f.run(input), { allowed: false, error: 'invalid_request', status: 400 });
  }
  assert.equal(f.authorizations.length, 0);
  assert.equal(f.reads(), 0);
});

test('unauthenticated sessions, or sessions without the advisor permission, stop before the authorization or the consent', async () => {
  const f = await accessFixture({ actor: null });
  assert.deepEqual(await f.run(webInput(f.id)), { allowed: false, error: 'unauthorized', status: 401 });
  const plain = await accessFixture({ actor: { kind: 'user', channel: 'web', principal: customer, operations: [] } });
  assert.deepEqual(await plain.run(webInput(plain.id)), { allowed: false, error: 'access_unavailable', status: 503 });
  assert.equal(f.reads() + plain.reads(), 0);
});

test('a foreign, unknown, revoked or expired authorization is one indistinguishable 403 that is recorded and never reads consent', async () => {
  const foreign = await accessFixture({ advisor: otherAdvisor });
  const revoked = await accessFixture();
  await revoked.store.revoke(customer, revoked.id, start, randomUUID());
  const expired = await accessFixture();
  expired.advance(2 * 86400000);
  const unknown = await accessFixture();
  const cases: [Awaited<ReturnType<typeof accessFixture>>, string][] = [[foreign, foreign.id], [revoked, revoked.id], [expired, expired.id], [unknown, randomUUID()]];
  for (const [f, id] of cases) {
    assert.deepEqual(await f.run(webInput(id)), { allowed: false, error: 'forbidden', status: 403 });
    assert.deepEqual(f.denials, [{ category: 'api_access', channel: 'web', operation: 'advisor-sale:prepare', cause: 'forbidden' }]);
    assert.equal(f.reads(), 0, 'no consent is read for an authorization the advisor does not hold');
  }
});

test('the customer consent is verified fresh on every use: missing, revoked or mixed consents block the offer', async () => {
  const denied = { allowed: false, reason: 'consent_revoked' } as ConsentDecision;
  const mixed = allGranted(); mixed[2] = grantedConsent({ consentId: 'CNS-2026-00002' });
  for (const consents of [RISK_SCOPES.map(() => denied), [...allGranted().slice(0, 3), denied], mixed]) {
    const f = await accessFixture({ consents });
    assert.deepEqual(await f.run(webInput(f.id)), { allowed: false, error: 'consent_required', status: 403 });
    assert.equal(f.denials.length, 1);
  }
  const f = await accessFixture();
  await f.run(webInput(f.id)); await f.run(webInput(f.id));
  assert.equal(f.reads(), 2, 'nothing is cached between requests');
});

test('a technical failure verifying consent, or recording a denial, blocks protected use instead of relaxing it', async () => {
  for (const consents of [() => Promise.reject(Error('identity down')), [] as ConsentDecision[], [...allGranted().slice(0, 3), { allowed: false, reason: 'unavailable' } as ConsentDecision]]) {
    const f = await accessFixture({ consents });
    assert.deepEqual(await f.run(webInput(f.id)), { allowed: false, error: 'access_unavailable', status: 503 });
  }
  const f = await accessFixture({ denyFails: true });
  assert.deepEqual(await f.run(webInput(randomUUID())), { allowed: false, error: 'access_unavailable', status: 503 });
});
