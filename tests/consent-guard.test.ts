import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityConsentGuard } from '../backend/acquisition-risk/src/adapters/outbound/identity-consent-guard';
import type { IdentityConsentRpc } from '../backend/acquisition-risk/src/adapters/outbound/identity-consent-guard';
import { ReadSignal } from '../backend/acquisition-risk/src/application/read-signal';
import type { SignalProvider, SignalSnapshot, SignalSnapshots } from '../backend/acquisition-risk/src/application/ports/signal-sources';
import { SIGNAL_SCOPES } from '../backend/acquisition-risk/src/domain/signal';
import type { Signal, SignalScope } from '../backend/acquisition-risk/src/domain/signal';
import { HmacIntegrity } from '../backend/identity-consent-ecosystem/src/adapters/outbound/hmac-integrity';
import { Consents } from '../backend/identity-consent-ecosystem/src/application/consents';
import type { ConsentCheck } from '../backend/identity-consent-ecosystem/src/application/consents';
import { ANA, LUIS, MemoryConsents, SEAL_KEY, TRACE, clock } from './support/consent-fakes';

// A simulated provider that only counts how often it is reached. No real source is queried.
class CountingProvider implements SignalProvider {
  calls = 0;
  failing = false;
  async read(_subject: string, scope: SignalScope): Promise<Signal> {
    this.calls++;
    if (this.failing) throw new Error('provider_down');
    return { scope, capturedAt: '2026-10-08T15:00:00Z', data: { simulated: true } };
  }
}
class CountingSnapshots implements SignalSnapshots {
  reads = 0;
  copy: SignalSnapshot | null = null;
  async find() { this.reads++; return this.copy; }
}

// Identity's real consent rules behind the same Service Binding contract the Worker exposes.
function rig(identity?: IdentityConsentRpc) {
  const store = new MemoryConsents();
  const time = clock();
  const consents = new Consents({ store, platform: time, integrity: new HmacIntegrity(SEAL_KEY) });
  const rpcCalls: unknown[] = [];
  const rpc: IdentityConsentRpc = identity ?? { verifyConsentV1: async request => { rpcCalls.push(request); return consents.verify(request as ConsentCheck); } };
  const provider = new CountingProvider();
  const snapshots = new CountingSnapshots();
  const read = new ReadSignal({ guard: new IdentityConsentGuard(rpc, 50), provider, snapshots });
  const ask = (subjectToken = ANA.subjectToken, scope: SignalScope = 'income_obligations_12m') => read.execute({ subjectToken, scope, traceId: TRACE });
  const grant = (principal = ANA, key = 'key-1') => consents.grant({ principal, idempotencyKey: key, body: { textVersion: 2, locale: 'es-CO' }, traceId: TRACE });
  return { store, time, consents, provider, snapshots, rpcCalls, ask, grant };
}
const untouched = (r: ReturnType<typeof rig>) => assert.deepEqual({ provider: r.provider.calls, copies: r.snapshots.reads }, { provider: 0, copies: 0 });

test('Acquisition accepts expanded consent counters and refuses IDs outside the contract', async () => {
  for (const consentId of ['CNS-2026-99999', 'CNS-2026-100000', 'CNS-2026-9007199254740992', 'CNS-2026-9223372036854775807']) {
    const r = rig({ verifyConsentV1: async () => ({ allowed: true, consent: { consentId, textVersion: 2, expiresAt: '2027-01-06T15:00:00Z' } }) });
    const result = await r.ask();
    assert.ok(result.status === 'available' && result.consentId === consentId);
    assert.equal(r.provider.calls, 1);
  }
  for (const consentId of ['CNS-2026-9999', 'CNS-2026-12345678901234567890']) {
    const r = rig({ verifyConsentV1: async () => ({ allowed: true, consent: { consentId, textVersion: 2, expiresAt: '2027-01-06T15:00:00Z' } }) });
    assert.deepEqual(await r.ask(), { status: 'denied', reason: 'unavailable' });
    untouched(r);
  }
});

test('without a consent neither the provider nor a stored copy is reached', async () => {
  const r = rig();
  assert.deepEqual(await r.ask(), { status: 'denied', reason: 'consent_missing' });
  untouched(r);
});

test('declining the authorization leaves the source untouched', async () => {
  const r = rig();
  await r.consents.decline({ principal: ANA, body: { textVersion: 2 }, traceId: TRACE });
  assert.deepEqual(await r.ask(), { status: 'denied', reason: 'consent_missing' });
  untouched(r);
});

test('with an active consent the provider is read, for every scope of the authorization', async () => {
  const r = rig();
  const granted = await r.grant();
  assert.ok(granted.status === 'created');
  for (const scope of SIGNAL_SCOPES) {
    const result = await r.ask(ANA.subjectToken, scope);
    assert.ok(result.status === 'available' && result.signal.scope === scope && granted.status === 'created' && result.consentId === granted.consent.consentId);
  }
  assert.equal(r.provider.calls, SIGNAL_SCOPES.length);
});

test('a revocation blocks the very next read and nothing more is reached', async () => {
  const r = rig();
  const granted = await r.grant();
  assert.equal((await r.ask()).status, 'available');
  assert.equal(r.provider.calls, 1);
  if (granted.status === 'created') await r.consents.revoke({ principal: ANA, consentCode: granted.consent.consentId, traceId: TRACE });
  assert.deepEqual(await r.ask(), { status: 'denied', reason: 'consent_revoked' });
  assert.deepEqual({ provider: r.provider.calls, copies: r.snapshots.reads }, { provider: 1, copies: 0 });
});

test('an expired consent blocks the read', async () => {
  const r = rig();
  await r.grant();
  r.time.advance(90);
  assert.deepEqual(await r.ask(), { status: 'denied', reason: 'consent_expired' });
  untouched(r);
});

test('a record altered after the grant blocks the read', async () => {
  const r = rig();
  await r.grant();
  r.store.consents[0].expiresAt = new Date(r.store.consents[0].expiresAt.getTime() + 365 * 24 * 60 * 60 * 1000);
  assert.deepEqual(await r.ask(), { status: 'denied', reason: 'consent_invalid' });
  untouched(r);
});

test('the consent of one user never opens the data of another', async () => {
  const r = rig();
  await r.grant(ANA);
  assert.deepEqual(await r.ask(LUIS.subjectToken), { status: 'denied', reason: 'consent_missing' });
  untouched(r);
});

test('the check is repeated on every call and never reused', async () => {
  const r = rig();
  await r.grant();
  await r.ask(); await r.ask(); await r.ask();
  assert.equal(r.rpcCalls.length, 3);
  assert.deepEqual(r.rpcCalls[0], { subjectToken: ANA.subjectToken, purposeCode: 'risk_profiling', scope: 'income_obligations_12m' });
});

test('if Identity cannot answer, is slow or answers something unexpected, access is denied', async () => {
  const replies: [string, () => Promise<unknown>][] = [
    ['throws', async () => { throw new Error('binding exploded'); }],
    ['never answers', () => new Promise(() => {})],
    ['not an object', async () => 'yes'],
    ['allowed without consent', async () => ({ allowed: true })],
    ['allowed with a malformed consent', async () => ({ allowed: true, consent: { consentId: 'x', textVersion: 2, expiresAt: 'tomorrow' } })],
    ['unknown reason', async () => ({ allowed: false, reason: 'because' })]
  ];
  for (const [label, reply] of replies) {
    const r = rig({ verifyConsentV1: reply });
    assert.deepEqual(await r.ask(), { status: 'denied', reason: 'unavailable' }, label);
    untouched(r);
  }
});

test('a scope outside the authorization is refused by Identity and reaches nothing', async () => {
  const r = rig();
  await r.grant();
  assert.deepEqual(await r.ask(ANA.subjectToken, 'credit_card_balance' as never), { status: 'denied', reason: 'invalid_request' });
  assert.equal(r.provider.calls, 0);
});

test('a stored copy is used only when the provider fails and only if it was captured under the same valid consent', async () => {
  const r = rig();
  const granted = await r.grant();
  assert.ok(granted.status === 'created');
  if (granted.status !== 'created') return;
  const signal: Signal = { scope: 'income_obligations_12m', capturedAt: '2026-10-01T12:00:00Z', data: { cached: true } };
  r.provider.failing = true;

  r.snapshots.copy = { consentId: granted.consent.consentId, signal };
  assert.deepEqual(await r.ask(), { status: 'degraded', signal, consentId: granted.consent.consentId });

  r.snapshots.copy = { consentId: 'CNS-2026-99999', signal };
  assert.deepEqual(await r.ask(), { status: 'unavailable', consentId: granted.consent.consentId });

  r.snapshots.copy = null;
  assert.equal((await r.ask()).status, 'unavailable');

  r.snapshots.copy = { consentId: granted.consent.consentId, signal };
  await r.consents.revoke({ principal: ANA, consentCode: granted.consent.consentId, traceId: TRACE });
  const reads = r.snapshots.reads;
  assert.deepEqual(await r.ask(), { status: 'denied', reason: 'consent_revoked' });
  assert.equal(r.snapshots.reads, reads, 'a revoked consent never reads the copy');
});
