import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityDecisions } from '../backend/identity-consent-ecosystem/src/application/security-decisions';
import { securityDecision } from '../backend/identity-consent-ecosystem/src/domain/security-decision';
import type { SecurityDecision } from '../backend/identity-consent-ecosystem/src/domain/security-decision';
import { authorizeApiAccess } from '../backend/identity-consent-ecosystem/src/adapters/inbound/api-access-http';
import type { ApiAccessDependencies } from '../backend/identity-consent-ecosystem/src/adapters/inbound/api-access-http';
import { ApiAccess } from '../backend/identity-consent-ecosystem/src/application/api-access';
import { Consents } from '../backend/identity-consent-ecosystem/src/application/consents';
import { HmacIntegrity } from '../backend/identity-consent-ecosystem/src/adapters/outbound/hmac-integrity';
import { RegisteredDevices } from '../backend/identity-consent-ecosystem/src/application/registered-devices';
import { ANA, LUIS, MemoryConsents, SEAL_KEY, TRACE, clock } from './support/consent-fakes';

function fixture() {
  const events: SecurityDecision[] = [];
  let fail = false;
  const security = new SecurityDecisions({ append: async decision => {
    if (fail) throw Error('synthetic-private-storage-error');
    events.push(decision);
  } }, () => crypto.randomUUID());
  const access: ApiAccessDependencies = {
    security,
    application: new ApiAccess({ find: async () => null }, {
      find: async () => null, open: async () => assert.fail('unexpected registration'), revoke: async () => assert.fail('unexpected revocation'),
    }),
    partner: { authenticate: async () => null },
    web: { authenticate: async () => null, allowedOrigins: ['https://synthetic.invalid'] },
  };
  return { events, security, access, fail: () => { fail = true; } };
}

test('security records contain only the canonical decision shape and normalized UUIDs', async () => {
  const state = fixture();
  const input = { category: 'api_access' as const, channel: 'web' as const, operation: 'quotes:create' as const,
    cause: 'unauthorized' as const, token: 'synthetic-private-token', email: 'synthetic@example.invalid' };
  await state.security.deny(input, TRACE.toUpperCase());
  const event = state.events[0];
  assert.equal(event.correlationId, TRACE);
  assert.deepEqual(Object.keys(event).sort(), ['category', 'cause', 'channel', 'correlationId', 'decisionId', 'operation', 'schemaVersion']);
  assert.ok(!JSON.stringify(event).includes('synthetic-private'));
  assert.throws(() => securityDecision({ ...input, cause: 'arbitrary' as 'unauthorized' }, crypto.randomUUID(), TRACE), /invalid_security_decision/);
  assert.throws(() => securityDecision({ ...input, category: 'consent_use' }, crypto.randomUUID(), TRACE), /invalid_security_decision/);
  await state.security.deny(input, 'synthetic-private-trace');
  assert.equal(state.events[1].correlationId, state.events[1].decisionId);
});

test('access denials are recorded once, without credentials, before returning the canonical denial', async () => {
  const state = fixture();
  const denied = await authorizeApiAccess(state.access, { kind: 'partner', token: 'synthetic-private-token', operation: 'quotes:create', traceId: TRACE });
  assert.deepEqual(denied, { allowed: false, error: 'unauthorized', status: 401 });
  assert.equal(state.events.length, 1);
  assert.deepEqual({ ...state.events[0], decisionId: 'generated' }, {
    schemaVersion: 1, decisionId: 'generated', correlationId: TRACE, category: 'api_access', channel: 'partner', operation: 'quotes:create', cause: 'unauthorized',
  });
  assert.deepEqual(await authorizeApiAccess(state.access, { kind: 'web', cookie: 'synthetic-private-cookie', origin: 'https://foreign.invalid', method: 'POST', operation: 'consents:write', traceId: TRACE }),
    { allowed: false, error: 'forbidden', status: 403 });
  assert.equal(state.events[1].cause, 'forbidden');
  assert.equal(JSON.stringify(state.events).includes('synthetic-private'), false);
  state.fail();
  assert.deepEqual(await authorizeApiAccess(state.access, { kind: 'partner', token: '', operation: 'quotes:create', traceId: TRACE }),
    { allowed: false, error: 'access_unavailable', status: 503 });
  assert.equal(state.events.length, 2);
});

test('a denied response waits for security persistence and technical failures create no false rejection record', async () => {
  const state = fixture();
  let release!: () => void;
  let finished = false;
  state.access.security = { deny: async () => new Promise<void>(resolve => { release = resolve; }) };
  const pending = authorizeApiAccess(state.access, { kind: 'partner', token: '', operation: 'quotes:create' }).then(value => { finished = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  release();
  assert.equal((await pending).allowed, false);
  state.access.security = state.security;
  state.access.partner = { authenticate: async () => { throw Error('synthetic-private-provider'); } };
  assert.deepEqual(await authorizeApiAccess(state.access, { kind: 'partner', token: 'synthetic', operation: 'quotes:create' }), { allowed: false, error: 'access_unavailable', status: 503 });
  assert.equal(state.events.length, 0);
});

test('consent use records missing subjects, invalid scope, revocation, expiry and altered seals without copying input', async () => {
  const state = fixture();
  const store = new MemoryConsents();
  const platform = clock();
  const consents = new Consents({ store, platform, integrity: new HmacIntegrity(SEAL_KEY), security: state.security });
  await consents.grant({ principal: ANA, idempotencyKey: 'synthetic', body: { textVersion: 2, locale: 'es-CO' }, traceId: TRACE });
  const input = { subjectToken: ANA.subjectToken, purposeCode: 'risk_profiling', scope: 'payment_history_score', traceId: TRACE };
  assert.equal((await consents.verify(input)).allowed, true);
  assert.equal(state.events.length, 0);
  assert.deepEqual(await consents.verify({ ...input, subjectToken: LUIS.subjectToken }), { allowed: false, reason: 'consent_missing' });
  assert.deepEqual(await consents.verify({ ...input, scope: 'synthetic-private-scope' }), { allowed: false, reason: 'invalid_request' });
  store.consents[0].seal = 'tampered';
  assert.deepEqual(await consents.verify(input), { allowed: false, reason: 'consent_invalid' });
  store.consents[0].revokedAt = platform.now();
  assert.deepEqual(await consents.verify(input), { allowed: false, reason: 'consent_revoked' });
  store.consents[0].revokedAt = null;
  platform.advance(91);
  assert.deepEqual(await consents.verify(input), { allowed: false, reason: 'consent_expired' });
  assert.deepEqual(state.events.map(event => event.cause), ['consent_missing', 'consent_request_invalid', 'consent_invalid', 'consent_revoked', 'consent_expired']);
  assert.ok(state.events.every(event => event.correlationId === TRACE && event.category === 'consent_use'));
  assert.equal(JSON.stringify(state.events).includes(ANA.subjectToken), false);
  state.fail();
  assert.deepEqual(await consents.verify(input), { allowed: false, reason: 'unavailable' });
  assert.equal(state.events.length, 5);
});

test('device policy denials keep their existing transaction while previously unrecorded denials gain a security event', async () => {
  const state = fixture();
  const input = { identity: { providerSubject: 'synthetic-subject', sessionReference: 'synthetic-session', emailVerified: true }, installationId: crypto.randomUUID(), correlationId: TRACE };
  const devices = new RegisteredDevices({ execute: async (_input, decide) => {
    const plan = decide({ observedAt: 700_000, session: { clientActive: true, createdAt: 0, expiresAt: 900_000, revoked: false }, bindings: [] });
    assert.equal(plan.decision.effect, 'deny');
    return null;
  } }, state.security);
  assert.equal(await devices.execute('register', input), null);
  assert.equal(state.events.length, 0, 'existing durable policy decision is not duplicated');
  assert.equal(await devices.execute('find', input), null);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].operation, 'mobile:devices');
  state.fail();
  await assert.rejects(devices.execute('find', input), /synthetic-private-storage-error/);
});
