import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiAccess } from '../backend/identity-consent-ecosystem/src/application/api-access';
import { authorizeFinancialAccess } from '../backend/identity-consent-ecosystem/src/application/financial-access';
import type { AccessDecision, UserActor } from '../backend/identity-consent-ecosystem/src/application/api-access';
import type { ConsentDecision } from '../backend/identity-consent-ecosystem/src/application/consents';
import { authorizeApiAccess } from '../backend/identity-consent-ecosystem/src/adapters/inbound/api-access-http';
import { SecurityDecisions } from '../backend/identity-consent-ecosystem/src/application/security-decisions';
import type { SecurityDecision } from '../backend/identity-consent-ecosystem/src/domain/security-decision';

const principal = { clientId: '30000000-0000-4000-8000-000000000001', subjectToken: '40000000-0000-4000-8000-000000000001' };
const actor: UserActor = { kind: 'user', channel: 'web', principal, operations: ['offers:create'] };
const consent = { consentId: 'CNS-2026-00001', textVersion: 2, expiresAt: '2027-01-01T00:00:00.000Z' };
const request = { kind: 'web', operation: 'offers:create', cookie: 'synthetic-sealed', method: 'POST', origin: 'https://web.example' };

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
    verifyConsent: async (): Promise<ConsentDecision> => { consentCalls++; return { allowed: true, consent }; },
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
  assert.equal(consentCalls, 4);
});

test('combined financial RPC stops before consent lookup on failed authentication', async () => {
  let lookups = 0;
  const decision = await authorizeFinancialAccess({ authorize: async () => ({ allowed: false, error: 'unauthorized', status: 401 }), verifyConsent: async () => { lookups++; return { allowed: true, consent }; } }, request);
  assert.equal(decision.allowed, false);
  assert.equal(lookups, 0);
});

test('mortgage creation requires all four current scopes for the same sealed consent', async () => {
  const looked: string[] = [];
  const deps = { authorize: async (): Promise<AccessDecision> => ({ allowed: true, actor }), verifyConsent: async (input: { scope: string }): Promise<ConsentDecision> => { looked.push(input.scope); return { allowed: true, consent }; } };
  assert.deepEqual(await authorizeFinancialAccess(deps, request), { allowed: true, actor, consent });
  assert.equal(new Set(looked).size, 4);
  let index = 0;
  const mismatch = await authorizeFinancialAccess({ ...deps, verifyConsent: async () => ({ allowed: true, consent: { ...consent, textVersion: ++index } }) }, request);
  assert.deepEqual(mismatch, { allowed: false, error: 'consent_required', status: 403 });
});

test('missing or revoked consent cannot create a mortgage offer; acceptance gets no authorization to use signals', async () => {
  for (const reason of ['consent_missing', 'consent_revoked', 'consent_expired', 'consent_invalid'] as const) {
    const deps = { authorize: async (): Promise<AccessDecision> => ({ allowed: true, actor }), verifyConsent: async (): Promise<ConsentDecision> => ({ allowed: false, reason }) };
    assert.deepEqual(await authorizeFinancialAccess(deps, request), { allowed: false, error: 'consent_required', status: 403 });
    const accept = await authorizeFinancialAccess(deps, { ...request, operation: 'offers:accept' });
    assert.deepEqual(accept, { allowed: true, actor });
    assert.ok(!('consent' in accept));
  }
});

test('technical consent verification failure never becomes a consent-free authorization', async () => {
  for (const operation of ['offers:create', 'offers:accept']) {
    const actual = await authorizeFinancialAccess({ authorize: async () => ({ allowed: true, actor }), verifyConsent: async () => ({ allowed: false, reason: 'unavailable' }) }, { ...request, operation });
    assert.deepEqual(actual, { allowed: false, error: 'access_unavailable', status: 503 });
  }
});

test('no-signals product creation and policy operations never query risk-data consent', async () => {
  for (const operation of ['offers:create-flight', 'offers:read', 'policies:read', 'policies:issue']) {
    assert.deepEqual(await authorizeFinancialAccess({ authorize: async () => ({ allowed: true, actor }), verifyConsent: async () => { throw Error('not applicable'); } }, { ...request, operation }), { allowed: true, actor });
  }
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
    verifyConsent: async (): Promise<ConsentDecision> => ({ allowed: false, reason: 'consent_missing' }),
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
    verifyConsent: async (): Promise<ConsentDecision> => assert.fail('denied channels never query consent'),
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
