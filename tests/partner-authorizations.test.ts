import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ApiAccess } from '../backend/identity-consent-ecosystem/src/application/api-access';
import { PartnerAuthorizations } from '../backend/identity-consent-ecosystem/src/application/partner-authorizations';
import { authorizePartnerOfferAccess, RISK_SCOPES } from '../backend/identity-consent-ecosystem/src/application/partner-offer-access';
import { PARTNER_OFFER_OPERATION } from '../backend/identity-consent-ecosystem/src/domain/partner-authorization';
import { MemoryPartnerAuthorizations } from './support/partner-authorization-fakes';
import { createHttp } from '../backend/identity-consent-ecosystem/src/adapters/inbound/http';
import type { ConsentDecision } from '../backend/identity-consent-ecosystem/src/application/consents';

const customer = { clientId: randomUUID(), subjectToken: randomUUID() };
const otherCustomer = { clientId: randomUUID(), subjectToken: randomUUID() };
const partnerId = randomUUID();
const otherPartnerId = randomUUID();
const partners = new Map([['acme', partnerId], ['globex', otherPartnerId]]);
const start = new Date('2026-11-09T12:00:00.000Z');

function fixture() {
  let now = start;
  const store = new MemoryPartnerAuthorizations(partners, () => now);
  const service = new PartnerAuthorizations({ store, now: () => now });
  return { store, service, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

test('a customer authorizes a named partner for 30 days by default and the view never exposes internal identifiers', async () => {
  const { service } = fixture();
  const result = await service.grant({ principal: customer, body: { partnerCode: 'acme' }, traceId: randomUUID() });
  assert.equal(result.status, 'created');
  if (result.status !== 'created') return;
  assert.equal(result.authorization.status, 'active');
  assert.equal(result.authorization.expiresAt, '2026-12-09T12:00:00.000Z');
  assert.deepEqual(Object.keys(result.authorization).sort(), ['authorizationId', 'expiresAt', 'grantedAt', 'operation', 'partnerCode', 'revokedAt', 'status']);
});

test('the grant body accepts only a partner code and a validity from 1 to 90 days', async () => {
  const { service } = fixture();
  for (const body of [undefined, null, [], {}, { partnerCode: 'ACME' }, { partnerCode: 'acme', clientId: customer.clientId }, { partnerCode: 'acme', validityDays: 0 },
    { partnerCode: 'acme', validityDays: 91 }, { partnerCode: 'acme', validityDays: 1.5 }, { partnerCode: 'acme', validityDays: '30' }, { partnerCode: '-acme' }, { partnerCode: 'a'.repeat(65) }]) {
    assert.equal((await service.grant({ principal: customer, body, traceId: randomUUID() })).status, 'invalid', JSON.stringify(body));
  }
  assert.equal((await service.grant({ principal: customer, body: { partnerCode: 'acme', validityDays: 90 }, traceId: randomUUID() })).status, 'created');
  assert.equal((await service.grant({ principal: customer, body: { partnerCode: 'unknown' }, traceId: randomUUID() })).status, 'partner_not_found');
});

test('a customer lists and revokes only their own authorizations, and a revoked or expired one is reported as such', async () => {
  const { service, advance } = fixture();
  const first = await service.grant({ principal: customer, body: { partnerCode: 'acme', validityDays: 1 }, traceId: randomUUID() });
  await service.grant({ principal: otherCustomer, body: { partnerCode: 'acme' }, traceId: randomUUID() });
  if (first.status !== 'created') throw Error('unreachable');
  const id = first.authorization.authorizationId;
  assert.deepEqual((await service.list(customer)).items.map(item => item.authorizationId), [id]);
  assert.equal((await service.revoke({ principal: otherCustomer, authorizationId: id, traceId: randomUUID() })).status, 'not_found');
  const revoked = await service.revoke({ principal: customer, authorizationId: id, traceId: randomUUID() });
  assert.equal(revoked.status === 'revoked' && revoked.authorization.status, 'revoked');
  assert.equal((await service.revoke({ principal: customer, authorizationId: id, traceId: randomUUID() })).status, 'revoked', 'revoking twice answers the same record');
  assert.equal((await service.revoke({ principal: customer, authorizationId: 'not-a-uuid', traceId: randomUUID() })).status, 'invalid');
  const second = await service.grant({ principal: customer, body: { partnerCode: 'acme', validityDays: 1 }, traceId: randomUUID() });
  if (second.status !== 'created') throw Error('unreachable');
  advance(2 * 86400000);
  assert.equal((await service.list(customer)).items[0].status, 'expired');
  assert.equal((await service.revoke({ principal: customer, authorizationId: second.authorization.authorizationId, traceId: randomUUID() })).status, 'not_active');
});

const noAuthentication = { authenticate: async () => null, sessions: () => { throw Error('unused'); } } as never;
function http(actor: unknown, service = fixture().service) {
  const seen: unknown[] = [];
  const app = createHttp({ authentication: noAuthentication, partnerAuthorizations: service,
    authorizeApiAccess: async (input: unknown) => { seen.push(input); return actor === null ? { allowed: false, error: 'unauthorized', status: 401 } : { allowed: true, actor }; } } as never);
  const call = (path: string, init: RequestInit = {}) => app.request('http://localhost' + path, { ...init, headers: { 'content-type': 'application/json', ...init.headers } }, { APP_ENV: 'local' } as never);
  return { call, seen };
}
const userActor = { kind: 'user', channel: 'web', principal: customer, operations: [] };

test('the web routes authorize the session for the exact operation and never read the customer from the body', async () => {
  const { call, seen } = http(userActor);
  const created = await call('/api/v1/me/partner-authorizations', { method: 'POST', body: JSON.stringify({ partnerCode: 'acme' }) });
  assert.equal(created.status, 201);
  const body = await created.json() as { authorizationId: string; traceId: string };
  assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.equal((await call('/api/v1/me/partner-authorizations')).status, 200);
  assert.deepEqual((seen as { operation: string; kind: string }[]).map(input => [input.kind, input.operation]), [['web', 'partner-authorizations:write'], ['web', 'partner-authorizations:read']]);
  assert.equal((await call(`/api/v1/me/partner-authorizations/${body.authorizationId}/revoke`, { method: 'POST' })).status, 200);
  const foreign = await call('/api/v1/me/partner-authorizations', { method: 'POST', body: JSON.stringify({ partnerCode: 'acme', clientId: otherCustomer.clientId }) });
  assert.equal(foreign.status, 400);
});

test('the web routes reject bearer tokens, partner actors, missing sessions, unknown partners and unknown authorizations', async () => {
  assert.equal((await http(userActor).call('/api/v1/me/partner-authorizations', { headers: { authorization: 'Bearer abc' } })).status, 400);
  assert.equal((await http({ kind: 'partner', partnerId, credentialId: randomUUID(), scopes: [] }).call('/api/v1/me/partner-authorizations')).status, 403);
  assert.equal((await http(null).call('/api/v1/me/partner-authorizations')).status, 401);
  assert.equal((await http(userActor).call('/api/v1/me/partner-authorizations', { method: 'POST', body: JSON.stringify({ partnerCode: 'unknown' }) })).status, 404);
  assert.equal((await http(userActor).call(`/api/v1/me/partner-authorizations/${randomUUID()}/revoke`, { method: 'POST' })).status, 404);
  assert.equal((await http(userActor).call('/api/v1/me/partner-authorizations/not-a-uuid/revoke', { method: 'POST' })).status, 400);
});

test('operation policy: only a partner credential holds partner-offers:create, and only a web customer manages authorizations', async () => {
  const sessions = { find: async () => ({ clientId: customer.clientId, subjectToken: customer.subjectToken }) } as never;
  const identity = { emailVerified: true, providerSubject: 'user_1', sessionReference: 'session_1' } as never;
  const access = new ApiAccess({ find: async () => ({ partnerId, credentialId: randomUUID(), scopes: ['quotes:create', PARTNER_OFFER_OPERATION] }) }, sessions);
  const partnerIdentity = { issuer: 'https://synthetic.authkit.app', organizationId: 'org_synthetic', applicationId: 'client_synthetic', scopes: ['quotes:create', PARTNER_OFFER_OPERATION] };
  assert.equal((await access.partner(partnerIdentity, PARTNER_OFFER_OPERATION)).allowed, true);
  assert.deepEqual(await access.partner({ ...partnerIdentity, scopes: ['quotes:create'] }, PARTNER_OFFER_OPERATION), { allowed: false, error: 'forbidden', status: 403 });
  // Even a credential and token that both carry the scope never give a partner a customer-only operation.
  const customerOnly = ['partner-authorizations:read', 'partner-authorizations:write', 'consents:write'];
  const greedy = new ApiAccess({ find: async () => ({ partnerId, credentialId: randomUUID(), scopes: customerOnly }) }, sessions);
  for (const operation of customerOnly) assert.deepEqual(await greedy.partner({ ...partnerIdentity, scopes: customerOnly }, operation), { allowed: false, error: 'forbidden', status: 403 }, operation);
  for (const operation of ['partner-authorizations:read', 'partner-authorizations:write']) {
    assert.equal((await access.partner(partnerIdentity, operation)).allowed, false, `partner cannot ${operation}`);
    assert.equal((await access.webUser(identity, operation)).allowed, true, `web customer can ${operation}`);
    assert.equal((await access.mobileUser(identity, operation)).allowed, false, `native customer cannot ${operation}`);
  }
  assert.deepEqual(await access.webUser(identity, PARTNER_OFFER_OPERATION), { allowed: false, error: 'forbidden', status: 403 });
  assert.equal((await access.mobileUser(identity, PARTNER_OFFER_OPERATION)).allowed, false);
});

const grantedConsent = (overrides: Partial<{ consentId: string; textVersion: number; expiresAt: string }> = {}): ConsentDecision =>
  ({ allowed: true, consent: { consentId: 'CNS-2026-00001', textVersion: 2, expiresAt: '2027-01-01T00:00:00.000Z', ...overrides } }) as ConsentDecision;
const allGranted = (): ConsentDecision[] => RISK_SCOPES.map(() => grantedConsent());

async function accessFixture(options: { actor?: unknown; consents?: ConsentDecision[] | (() => Promise<ConsentDecision[]>); denyFails?: boolean } = {}) {
  const { service, store, advance } = fixture();
  const granted = await service.grant({ principal: customer, body: { partnerCode: 'acme' }, traceId: randomUUID() });
  if (granted.status !== 'created') throw Error('unreachable');
  const denials: unknown[] = []; const authorizations: unknown[] = []; let consentReads = 0;
  const run = (input: unknown) => authorizePartnerOfferAccess({
    authorize: async request => { authorizations.push(request); return options.actor === null ? { allowed: false, error: 'unauthorized', status: 401 }
      : { allowed: true, actor: options.actor ?? { kind: 'partner', partnerId, credentialId: randomUUID(), scopes: [PARTNER_OFFER_OPERATION] } } as never; },
    authorizations: store,
    verifyConsents: async request => { consentReads++; assert.equal(request.subjectToken, customer.subjectToken); assert.deepEqual([...request.scopes], [...RISK_SCOPES]); assert.equal(request.purposeCode, 'risk_profiling');
      return typeof options.consents === 'function' ? options.consents() : options.consents ?? allGranted(); },
    security: { deny: async (denial: unknown) => { if (options.denyFails) throw Error('audit down'); denials.push(denial); } } as never
  }, input);
  return { run, id: granted.authorization.authorizationId, store, advance, denials, authorizations, reads: () => consentReads };
}

test('an authorized partner receives the customer behind the authorization and the fresh consent, never the other way round', async () => {
  const f = await accessFixture();
  const decision = await f.run({ token: 'partner.jwt.token', authorizationId: f.id, traceId: randomUUID() });
  assert.deepEqual(decision, { allowed: true, partnerId, customer, authorizationExpiresAt: '2026-12-09T12:00:00.000Z',
    consent: { consentId: 'CNS-2026-00001', textVersion: 2, expiresAt: '2027-01-01T00:00:00.000Z' } });
  assert.equal((f.authorizations[0] as { operation: string }).operation, PARTNER_OFFER_OPERATION);
  assert.equal((f.authorizations[0] as { kind: string }).kind, 'partner');
});

test('input without a bearer string or a UUID authorization is invalid before any authentication or lookup', async () => {
  const f = await accessFixture();
  for (const input of [null, {}, { token: 'x' }, { authorizationId: f.id }, { token: 'x', authorizationId: 'nope' }, { token: 1, authorizationId: f.id }]) {
    assert.deepEqual(await f.run(input), { allowed: false, error: 'invalid_request', status: 400 });
  }
  assert.equal(f.authorizations.length, 0);
  assert.equal(f.reads(), 0);
});

test('unauthenticated or unauthorized partners stop at authentication without touching the authorization or the consent', async () => {
  const f = await accessFixture({ actor: null });
  assert.deepEqual(await f.run({ token: '', authorizationId: f.id }), { allowed: false, error: 'unauthorized', status: 401 });
  assert.equal(f.reads(), 0);
  const web = await accessFixture({ actor: { kind: 'user', channel: 'web', principal: customer, operations: [] } });
  assert.deepEqual(await web.run({ token: 'x', authorizationId: web.id }), { allowed: false, error: 'access_unavailable', status: 503 });
});

test('a foreign, unknown, revoked or expired authorization is one indistinguishable 403 that is recorded and never reads consent', async () => {
  const foreign = await accessFixture({ actor: { kind: 'partner', partnerId: otherPartnerId, credentialId: randomUUID(), scopes: [] } });
  const revoked = await accessFixture();
  await revoked.store.revoke(customer, revoked.id, new Date(), randomUUID());
  const expired = await accessFixture();
  expired.advance(31 * 86400000);
  const unknown = await accessFixture();
  const cases: [Awaited<ReturnType<typeof accessFixture>>, string][] = [[foreign, foreign.id], [revoked, revoked.id], [expired, expired.id], [unknown, randomUUID()]];
  for (const [f, id] of cases) {
    assert.deepEqual(await f.run({ token: 'x', authorizationId: id, traceId: randomUUID() }), { allowed: false, error: 'forbidden', status: 403 });
    assert.deepEqual(f.denials, [{ category: 'api_access', channel: 'partner', operation: PARTNER_OFFER_OPERATION, cause: 'forbidden' }]);
    assert.equal(f.reads(), 0, 'no consent is read for an authorization the partner does not hold');
  }
});

test('the customer consent is verified fresh on every use: missing, revoked or mixed consents block the offer', async () => {
  const denied = { allowed: false, reason: 'consent_revoked' } as ConsentDecision;
  const mixed = allGranted(); mixed[2] = grantedConsent({ consentId: 'CNS-2026-00002' });
  for (const consents of [RISK_SCOPES.map(() => denied), [...allGranted().slice(0, 3), denied], mixed]) {
    const f = await accessFixture({ consents });
    assert.deepEqual(await f.run({ token: 'x', authorizationId: f.id }), { allowed: false, error: 'consent_required', status: 403 });
    assert.equal(f.denials.length, 1);
  }
  const f = await accessFixture();
  await f.run({ token: 'x', authorizationId: f.id }); await f.run({ token: 'x', authorizationId: f.id });
  assert.equal(f.reads(), 2, 'nothing is cached between requests');
});

test('a technical failure verifying consent, or recording a denial, blocks protected use instead of relaxing it', async () => {
  for (const consents of [() => Promise.reject(Error('identity down')), [] as ConsentDecision[], [...allGranted().slice(0, 3), { allowed: false, reason: 'unavailable' } as ConsentDecision],
    RISK_SCOPES.map(() => ({ allowed: false, reason: 'unavailable' }) as ConsentDecision)]) {
    const f = await accessFixture({ consents });
    assert.deepEqual(await f.run({ token: 'x', authorizationId: f.id }), { allowed: false, error: 'access_unavailable', status: 503 });
  }
  const f = await accessFixture({ denyFails: true });
  assert.deepEqual(await f.run({ token: 'x', authorizationId: randomUUID() }), { allowed: false, error: 'access_unavailable', status: 503 });
});

test('the operator registers quotes:create alone or with partner-offers:create, and nothing else', async () => {
  const { validatePartnerAccessInput } = await import('../infra/partner-access.mjs');
  const input = (scopes: unknown) => ({ partnerCode: 'acme', provider: 'workos-connect', reference: JSON.stringify(['https://synthetic.authkit.app', 'org_synthetic', 'client_synthetic']),
    scopes, expiresAt: new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z') });
  for (const scopes of [['quotes:create'], ['quotes:create', 'partner-offers:create']]) assert.doesNotThrow(() => validatePartnerAccessInput('local', 'register', input(scopes)));
  for (const scopes of [[], ['partner-offers:create'], ['quotes:create', 'quotes:create'], ['quotes:create', 'offers:accept'], ['quotes:create', 'partner-offers:create', 'consents:write'], 'quotes:create']) {
    assert.throws(() => validatePartnerAccessInput('local', 'register', input(scopes)), /invalid_scopes/, JSON.stringify(scopes));
  }
});
