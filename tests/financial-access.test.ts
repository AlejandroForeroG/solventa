import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from 'pg';
import { ApiAccess } from '../backend/identity-consent-ecosystem/src/application/api-access';
import { authorizeFinancialAccess } from '../backend/identity-consent-ecosystem/src/application/financial-access';
import type { AccessDecision, UserActor } from '../backend/identity-consent-ecosystem/src/application/api-access';
import { Consents } from '../backend/identity-consent-ecosystem/src/application/consents';
import type { ConsentDecision, ConsentScopesCheck } from '../backend/identity-consent-ecosystem/src/application/consents';
import { authorizeApiAccess } from '../backend/identity-consent-ecosystem/src/adapters/inbound/api-access-http';
import { HmacIntegrity } from '../backend/identity-consent-ecosystem/src/adapters/outbound/hmac-integrity';
import { SecurityDecisions } from '../backend/identity-consent-ecosystem/src/application/security-decisions';
import { SqlIdentitySessions } from '../backend/identity-consent-ecosystem/src/adapters/outbound/identity-sessions';
import { SqlConsents } from '../backend/identity-consent-ecosystem/src/adapters/outbound/sql-consents';
import { WORDING_FINGERPRINT, expiryFor, sealContent } from '../backend/identity-consent-ecosystem/src/domain/consent';
import type { Consent, ScopeCode } from '../backend/identity-consent-ecosystem/src/domain/consent';
import type { SecurityDecision } from '../backend/identity-consent-ecosystem/src/domain/security-decision';
import { ANA, MemoryConsents, SEAL_KEY, TRACE, clock } from './support/consent-fakes';

const principal = { clientId: '30000000-0000-4000-8000-000000000001', subjectToken: '40000000-0000-4000-8000-000000000001' };
const actor: UserActor = { kind: 'user', channel: 'web', principal, operations: ['offers:create'] };
const consent = { consentId: 'CNS-2026-00001', textVersion: 2, expiresAt: '2027-01-01T00:00:00.000Z' };
const request = { kind: 'web', operation: 'offers:create', cookie: 'synthetic-sealed', method: 'POST', origin: 'https://web.example' };
const SCOPES = ['income_obligations_12m', 'payment_history_score', 'affiliation_regime', 'identity_validation'];
const everyScope = (decision: ConsentDecision) => async (input: ConsentScopesCheck): Promise<ConsentDecision[]> => input.scopes.map(() => decision);
const byScope = (decide: (scope: string) => ConsentDecision) => async (input: ConsentScopesCheck): Promise<ConsentDecision[]> => input.scopes.map(decide);

test('financial access repositories reuse one caller-owned database connection', async () => {
  let queries = 0;
  const shared = {
    query: async () => ({ rows: ++queries === 1 ? [{ id: principal.clientId, subject_token: principal.subjectToken }] : [] }),
    connect: async () => assert.fail('a caller-owned connection is already connected'),
    end: async () => assert.fail('a repository must not close a caller-owned connection'),
    on: () => shared,
  } as unknown as Client;
  const identity = { emailVerified: true, providerSubject: 'synthetic-user', sessionReference: 'synthetic-session' };
  assert.deepEqual(await new SqlIdentitySessions('unused', shared).find(identity), principal);
  const found = await new SqlConsents('unused', shared).forSubjectScopes(principal.subjectToken, 'risk_profiling', SCOPES as readonly ScopeCode[], new Date('2026-10-28T00:00:00.000Z'));
  assert.equal(found.size, SCOPES.length);
  assert.equal(queries, 2);
});

// Identity's real consent rules over the in-memory store, behind the financial check of an authenticated web user.
function withConsents() {
  const store = new MemoryConsents();
  const time = clock();
  const integrity = new HmacIntegrity(SEAL_KEY);
  const consents = new Consents({ store, platform: time, integrity });
  const user: UserActor = { ...actor, principal: ANA };
  const deps = { authorize: async (): Promise<AccessDecision> => ({ allowed: true, actor: user }), verifyConsents: (input: ConsentScopesCheck) => consents.verifyScopes(input) };
  const grant = async (key: string) => {
    const result = await consents.grant({ principal: ANA, idempotencyKey: key, body: { textVersion: 2, locale: 'es-CO' }, traceId: TRACE });
    if (result.status !== 'created') throw Error('synthetic grant was not created');
    return { consentId: result.consent.consentId, textVersion: result.consent.textVersion, expiresAt: result.consent.expiresAt };
  };
  // A validly sealed record covering only some scopes, which the current terms cannot produce through a grant.
  const grantPartial = async (consentCode: string, scopes: Consent['scopes'], sources: Consent['sources']) => {
    const grantedAt = time.now();
    const base: Omit<Consent, 'consentCode' | 'revokedAt' | 'seal'> = { id: time.newId(), version: 1, clientId: ANA.clientId, purposeCode: 'risk_profiling',
      textVersion: 2, locale: 'es-CO', wordingHash: WORDING_FINGERPRINT['es-CO'], sources, scopes, grantedAt, expiresAt: expiryFor(grantedAt), quoteRef: null };
    store.consents.push({ ...base, consentCode, revokedAt: null, seal: await integrity.seal(sealContent(base)), subjectToken: ANA.subjectToken, idempotencyKey: consentCode, requestHash: consentCode });
  };
  return { store, time, consents, deps, user, grant, grantPartial };
}

test('financial operations are explicit web permissions, forbidden to native and partner identities', async () => {
  const app = new ApiAccess({ find: async () => { throw Error('partner lookup must not occur'); } }, { find: async () => principal, open: async () => principal, revoke: async () => {} });
  const identity = { emailVerified: true, providerSubject: 'synthetic-user', sessionReference: 'synthetic-session' };
  for (const operation of ['offers:create', 'offers:create-flight', 'offers:read', 'offers:accept', 'policies:read', 'policies:issue']) {
    assert.equal((await app.webUser(identity, operation)).allowed, true);
    assert.deepEqual(await app.mobileUser(identity, operation), { allowed: false, error: 'forbidden', status: 403 });
    assert.deepEqual(await app.partner({ issuer: 'https://synthetic.authkit.app', applicationId: 'client_synthetic', organizationId: 'org_synthetic', scopes: [operation] }, operation), { allowed: false, error: 'forbidden', status: 403 });
  }
});

test('the combined RPC preserves actual Origin and current local session enforcement', async () => {
  let providerCalls = 0;
  let consentCalls = 0;
  let sessionActive = true;
  const application = new ApiAccess({ find: async () => null }, { find: async () => sessionActive ? principal : null, open: async () => principal, revoke: async () => {} });
  const deps = {
    authorize: (input: unknown) => authorizeApiAccess({ application, partner: null, web: {
      allowedOrigins: ['https://web.example'],
      authenticate: async () => { providerCalls++; return { identity: { providerSubject: 'synthetic-user', sessionReference: 'synthetic-session', emailVerified: true } }; },
    } }, input),
    verifyConsents: async (input: ConsentScopesCheck): Promise<ConsentDecision[]> => { consentCalls++; return input.scopes.map(() => ({ allowed: true, consent })); },
  };
  assert.deepEqual(await authorizeFinancialAccess(deps, { ...request, origin: 'https://foreign.example' }), { allowed: false, error: 'forbidden', status: 403 });
  assert.equal(providerCalls, 0);
  assert.equal(consentCalls, 0);
  sessionActive = false;
  assert.deepEqual(await authorizeFinancialAccess(deps, request), { allowed: false, error: 'unauthorized', status: 401 });
  assert.equal(consentCalls, 0);
  sessionActive = true;
  const allowed = await authorizeFinancialAccess(deps, request);
  assert.ok(allowed.allowed);
  assert.equal(consentCalls, 1, 'one batch verification covers every mortgage scope');
});

test('combined financial RPC stops before consent lookup on failed authentication', async () => {
  let lookups = 0;
  const decision = await authorizeFinancialAccess({ authorize: async () => ({ allowed: false, error: 'unauthorized', status: 401 }), verifyConsents: async () => { lookups++; return SCOPES.map(() => ({ allowed: true, consent })); } }, request);
  assert.equal(decision.allowed, false);
  assert.equal(lookups, 0);
});

test('mortgage creation requires all four current scopes for the same sealed consent', async () => {
  const requests: ConsentScopesCheck[] = [];
  const deps = { authorize: async (): Promise<AccessDecision> => ({ allowed: true, actor }), verifyConsents: async (input: ConsentScopesCheck): Promise<ConsentDecision[]> => { requests.push(input); return input.scopes.map(() => ({ allowed: true, consent })); } };
  assert.deepEqual(await authorizeFinancialAccess(deps, request), { allowed: true, actor, consent });
  assert.deepEqual(requests, [{ subjectToken: principal.subjectToken, purposeCode: 'risk_profiling', scopes: SCOPES }]);
  let index = 0;
  const mismatch = await authorizeFinancialAccess({ ...deps, verifyConsents: byScope(() => ({ allowed: true, consent: { ...consent, textVersion: ++index } })) }, request);
  assert.deepEqual(mismatch, { allowed: false, error: 'consent_required', status: 403 });
});

test('missing or revoked consent cannot create a mortgage offer; acceptance gets no authorization to use signals', async () => {
  for (const reason of ['consent_missing', 'consent_revoked', 'consent_expired', 'consent_invalid'] as const) {
    const deps = { authorize: async (): Promise<AccessDecision> => ({ allowed: true, actor }), verifyConsents: everyScope({ allowed: false, reason }) };
    assert.deepEqual(await authorizeFinancialAccess(deps, request), { allowed: false, error: 'consent_required', status: 403 });
    const accept = await authorizeFinancialAccess(deps, { ...request, operation: 'offers:accept' });
    assert.deepEqual(accept, { allowed: true, actor });
    assert.ok(!('consent' in accept));
  }
});

test('technical consent verification failure never becomes a consent-free authorization', async () => {
  const failures: [string, (input: ConsentScopesCheck) => Promise<ConsentDecision[]>][] = [
    ['every scope unavailable', everyScope({ allowed: false, reason: 'unavailable' })],
    ['one scope unavailable after a business denial', byScope(scope => scope === 'identity_validation' ? { allowed: false, reason: 'unavailable' } : { allowed: false, reason: 'consent_missing' })],
    ['throwing verification', async () => { throw new Error('synthetic_read_failure'); }],
    ['incomplete result', async () => [{ allowed: true, consent }]],
    ['empty result', async () => []],
  ];
  for (const operation of ['offers:create', 'offers:accept']) for (const [label, verifyConsents] of failures) {
    const actual = await authorizeFinancialAccess({ authorize: async () => ({ allowed: true, actor }), verifyConsents }, { ...request, operation });
    assert.deepEqual(actual, { allowed: false, error: 'access_unavailable', status: 503 }, `${operation}: ${label}`);
  }
});

test('a single failed or mismatched scope never authorizes mortgage data', async () => {
  for (const failedScope of SCOPES) {
    for (const failure of [
      { allowed: false, reason: 'consent_revoked' },
      { allowed: false, reason: 'unavailable' },
      { allowed: true, consent: { ...consent, consentId: 'CNS-2026-00002' } },
      { allowed: true, consent: { ...consent, expiresAt: '2027-01-02T00:00:00.000Z' } },
    ] satisfies ConsentDecision[]) {
      const result = await authorizeFinancialAccess({
        authorize: async () => ({ allowed: true, actor }),
        verifyConsents: byScope(scope => scope === failedScope ? failure : { allowed: true, consent }),
      }, request);
      assert.deepEqual(result, !failure.allowed && failure.reason === 'unavailable'
        ? { allowed: false, error: 'access_unavailable', status: 503 }
        : { allowed: false, error: 'consent_required', status: 403 });
    }
  }
});

test('no-signals product creation and policy operations never query risk-data consent', async () => {
  for (const operation of ['offers:create-flight', 'offers:read', 'policies:read', 'policies:issue']) {
    assert.deepEqual(await authorizeFinancialAccess({ authorize: async () => ({ allowed: true, actor }), verifyConsents: async () => { throw Error('not applicable'); } }, { ...request, operation }), { allowed: true, actor });
  }
});

test('one fresh batch read per request authorizes the current grant and observes a revocation on the next request', async () => {
  const { store, consents, deps, user, grant } = withConsents();
  const granted = await grant('key-1');
  assert.deepEqual(await authorizeFinancialAccess(deps, request), { allowed: true, actor: user, consent: granted });
  assert.equal(store.scopeReads, 1);
  await consents.revoke({ principal: ANA, consentCode: granted.consentId, traceId: TRACE });
  assert.deepEqual(await authorizeFinancialAccess(deps, request), { allowed: false, error: 'consent_required', status: 403 });
  assert.deepEqual(await authorizeFinancialAccess(deps, { ...request, operation: 'offers:accept' }), { allowed: true, actor: user });
  assert.equal(store.scopeReads, 3, 'every request reads again; nothing is reused');
});

test('newer revoked or altered grants never hide an older active grant in any scope', async () => {
  const { store, time, consents, deps, user, grant } = withConsents();
  const older = await grant('older');
  time.advance(1);
  const revoked = await grant('revoked');
  time.advance(1);
  await grant('altered');
  await consents.revoke({ principal: ANA, consentCode: revoked.consentId, traceId: TRACE });
  const altered = store.consents.find(c => c.idempotencyKey === 'altered');
  assert.ok(altered);
  altered.quoteRef = 'COT-2026-99999';
  assert.deepEqual(await authorizeFinancialAccess(deps, request), { allowed: true, actor: user, consent: older });
});

test('scopes resolving to different grants are refused, and agree again when the partial grant is revoked', async () => {
  const { time, consents, deps, user, grant, grantPartial } = withConsents();
  const full = await grant('full');
  time.advance(1);
  await grantPartial('CNS-2026-09999', ['income_obligations_12m', 'payment_history_score'], ['open_finance_bancolombia', 'datacredito_experian']);
  assert.deepEqual(await authorizeFinancialAccess(deps, request), { allowed: false, error: 'consent_required', status: 403 });
  await consents.revoke({ principal: ANA, consentCode: 'CNS-2026-09999', traceId: TRACE });
  assert.deepEqual(await authorizeFinancialAccess(deps, request), { allowed: true, actor: user, consent: full });
});

test('a partial grant alone leaves uncovered scopes missing and allows only consent-free acceptance', async () => {
  const { deps, user, consents, grantPartial } = withConsents();
  await grantPartial('CNS-2026-09998', ['income_obligations_12m'], ['open_finance_bancolombia']);
  assert.deepEqual(await authorizeFinancialAccess(deps, request), { allowed: false, error: 'consent_required', status: 403 });
  assert.deepEqual(await authorizeFinancialAccess(deps, { ...request, operation: 'offers:accept' }), { allowed: true, actor: user });
  const decisions = await consents.verifyScopes({ subjectToken: ANA.subjectToken, purposeCode: 'risk_profiling', scopes: SCOPES });
  assert.deepEqual(decisions.map(decision => decision.allowed || decision.reason), [true, 'consent_missing', 'consent_missing', 'consent_missing']);
});

test('expired, altered and unavailable consent records are explained per scope and fail closed', async () => {
  const expired = withConsents();
  await expired.grant('key-1');
  expired.time.advance(90);
  assert.deepEqual(await authorizeFinancialAccess(expired.deps, request), { allowed: false, error: 'consent_required', status: 403 });
  assert.deepEqual(await expired.consents.verifyScopes({ subjectToken: ANA.subjectToken, purposeCode: 'risk_profiling', scopes: SCOPES }),
    SCOPES.map(() => ({ allowed: false, reason: 'consent_expired' })));

  const altered = withConsents();
  await altered.grant('key-1');
  altered.store.consents[0].expiresAt = new Date(altered.store.consents[0].expiresAt.getTime() + 365 * 24 * 60 * 60 * 1000);
  assert.deepEqual(await authorizeFinancialAccess(altered.deps, request), { allowed: false, error: 'consent_required', status: 403 });
  assert.deepEqual(await altered.consents.verifyScopes({ subjectToken: ANA.subjectToken, purposeCode: 'risk_profiling', scopes: SCOPES }),
    SCOPES.map(() => ({ allowed: false, reason: 'consent_invalid' })));

  const unavailable = withConsents();
  await unavailable.grant('key-1');
  unavailable.store.failing = true;
  for (const operation of ['offers:create', 'offers:accept']) {
    assert.deepEqual(await authorizeFinancialAccess(unavailable.deps, { ...request, operation }), { allowed: false, error: 'access_unavailable', status: 503 });
  }
});

test('batch verification accepts only known, distinct scopes for a valid subject and purpose', async () => {
  const { store, consents, grant } = withConsents();
  await grant('key-1');
  const valid = { subjectToken: ANA.subjectToken, purposeCode: 'risk_profiling', scopes: SCOPES };
  for (const over of [{ scopes: ['credit_card_balance'] }, { scopes: ['income_obligations_12m', 'income_obligations_12m'] }, { purposeCode: 'advertising' }, { subjectToken: 'not-a-uuid' }]) {
    const decisions = await consents.verifyScopes({ ...valid, ...over });
    assert.ok(decisions.length > 0 && decisions.every(decision => !decision.allowed && decision.reason === 'invalid_request'), JSON.stringify(over));
  }
  for (const scopes of [[], 'income_obligations_12m', null]) {
    assert.deepEqual(await consents.verifyScopes({ ...valid, scopes: scopes as never }), [{ allowed: false, reason: 'invalid_request' }]);
  }
  assert.equal(store.scopeReads, 0, 'invalid requests never reach the store');
});

test('batch verification records one consent-use denial per use and blocks when that record fails', async () => {
  const store = new MemoryConsents();
  const decisions: SecurityDecision[] = [];
  let failing = false;
  const security = new SecurityDecisions({ append: async decision => { if (failing) throw Error('synthetic audit failure'); decisions.push(decision); } }, () => '60000000-0000-4000-8000-000000000001');
  const consents = new Consents({ store, platform: clock(), integrity: new HmacIntegrity(SEAL_KEY), security });
  const check = { subjectToken: ANA.subjectToken, purposeCode: 'risk_profiling', scopes: SCOPES, traceId: TRACE };
  assert.deepEqual(await consents.verifyScopes(check), SCOPES.map(() => ({ allowed: false, reason: 'consent_missing' })));
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].category, 'consent_use');
  assert.equal(decisions[0].cause, 'consent_missing');
  assert.equal(decisions[0].correlationId, TRACE);
  failing = true;
  assert.deepEqual(await consents.verifyScopes(check), SCOPES.map(() => ({ allowed: false, reason: 'unavailable' })));
});

test('financial authentication and final mortgage denials use the existing audit wrapper exactly once, while optional flight consent creates no alert', async () => {
  const decisions: SecurityDecision[] = [];
  const traceId = '50000000-0000-4000-8000-000000000001';
  let failing = false;
  const security = new SecurityDecisions({ append: async decision => { if (failing) throw Error('synthetic audit failure'); decisions.push(decision); } }, () => '60000000-0000-4000-8000-000000000001');
  const application = new ApiAccess({ find: async () => null }, { find: async () => principal, open: async () => principal, revoke: async () => {} });
  const deps = {
    security,
    authorize: (input: unknown) => authorizeApiAccess({ application, security, partner: null, web: { allowedOrigins: ['https://web.example'], authenticate: async () => ({ identity: { providerSubject: 'synthetic-user', sessionReference: 'synthetic-session', emailVerified: true } }) } }, input),
    verifyConsents: everyScope({ allowed: false, reason: 'consent_missing' }),
  };
  for (const [change, expected] of [[{ cookie: '' }, 401], [{ origin: 'https://foreign.example' }, 403], [{}, 403]] as const) {
    decisions.length = 0;
    const result = await authorizeFinancialAccess(deps, { ...request, traceId, ...change });
    assert.ok(!result.allowed);
    assert.equal(result.status, expected);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].correlationId, traceId);
    assert.equal(decisions[0].operation, 'offers:create');
    assert.ok(!JSON.stringify(decisions[0]).includes('synthetic-sealed'));
  }
  decisions.length = 0;
  assert.equal((await authorizeFinancialAccess(deps, { ...request, traceId, operation: 'offers:accept' })).allowed, true);
  assert.equal(decisions.length, 0);
  failing = true;
  for (const change of [{ cookie: '' }, {}]) {
    assert.deepEqual(await authorizeFinancialAccess(deps, { ...request, traceId, ...change }), { allowed: false, error: 'access_unavailable', status: 503 });
  }
});

test('native and partner financial requests reach the audited policy and record one denial; unknown channels remain invalid', async () => {
  const decisions: SecurityDecision[] = [];
  const security = new SecurityDecisions({ append: async decision => { decisions.push(decision); } }, () => '60000000-0000-4000-8000-000000000001');
  const identity = { emailVerified: true, providerSubject: 'synthetic-user', sessionReference: 'synthetic-session' };
  const application = new ApiAccess({ find: async () => assert.fail('financial permission denial precedes partner storage') }, { find: async () => assert.fail('financial permission denial precedes native storage'), open: async () => principal, revoke: async () => {} });
  const deps = {
    security,
    authorize: (input: unknown) => authorizeApiAccess({ application, security, web: null,
      mobile: { authenticate: async () => identity, authorize: (verified, operation) => application.mobileUser(verified, operation) },
      partner: { authenticate: async () => ({ issuer: 'https://synthetic.authkit.app', applicationId: 'client_synthetic', organizationId: 'org_synthetic', scopes: [] }) },
    }, input),
    verifyConsents: async (): Promise<ConsentDecision[]> => assert.fail('denied channels never query consent'),
  };
  const traceId = '50000000-0000-4000-8000-000000000001';
  for (const kind of ['partner', 'mobile']) for (const operation of ['offers:create', 'offers:create-flight', 'offers:read', 'offers:accept', 'policies:read', 'policies:issue']) {
    decisions.length = 0;
    assert.deepEqual(await authorizeFinancialAccess(deps, { kind, operation, token: 'synthetic-token', traceId }), { allowed: false, error: 'forbidden', status: 403 });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].channel, kind);
    assert.equal(decisions[0].operation, operation);
    assert.equal(decisions[0].correlationId, traceId);
  }
  decisions.length = 0;
  assert.deepEqual(await authorizeFinancialAccess(deps, { kind: 'unknown', operation: 'offers:create', traceId }), { allowed: false, error: 'invalid_request', status: 400 });
  assert.equal(decisions.length, 0);
});
