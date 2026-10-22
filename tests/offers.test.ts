import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OfferService } from '../backend/acquisition-risk/src/application/offer-service';
import type { AcceptedOffer, AcceptanceEvent, OfferStore, StoredOffer, StoredOfferRequest } from '../backend/acquisition-risk/src/application/ports/offer-store';
import { offerRequestIdentity, type OfferActor, type OfferQuote } from '../backend/acquisition-risk/src/domain/offer';
import { HmacOfferIntegrity, acceptanceContent } from '../backend/acquisition-risk/src/adapters/outbound/hmac-offer-integrity';
import { MockRiskSignals, MockFlightSchedule } from '../backend/acquisition-risk/src/adapters/outbound/mock-risk-signals';
import { eventContent, isOfferEnvelope } from '../backend/policy-claims-payments/src/domain/financial';
import { PROVIDER_FAILURES, ProviderFailure } from '../backend/acquisition-risk/src/application/ports/signal-sources';
import { SIGNAL_SCOPES } from '../backend/acquisition-risk/src/domain/signal';
import { createOffers } from '../backend/acquisition-risk/src/adapters/outbound/offer-composition';
import { sendWithinDeadline } from '../backend/acquisition-risk/src/adapters/outbound/financial-outbox-publisher';
import { ReadSignal } from '../backend/acquisition-risk/src/application/read-signal';
import type { SignalProvider, SignalSnapshot, SignalSnapshots } from '../backend/acquisition-risk/src/application/ports/signal-sources';

const actor = { clientId: '11111111-1111-4111-8111-111111111111', subjectToken: '22222222-2222-4222-8222-222222222222' };
const other = { clientId: '33333333-3333-4333-8333-333333333333', subjectToken: '44444444-4444-4444-8444-444444444444' };
const authorization = { consentId: 'CNS-2026-00001', textVersion: 1, expiresAt: '2026-10-16T12:00:00.000Z' };
const quote: OfferQuote = { id: randomUUID(), quoteId: 'COT-2026-00001', amount: 320000000, termMonths: 180, ageYears: 35, validUntil: '2026-11-01T12:00:00.000Z' };
class MemoryOffers implements OfferStore {
  rows = new Map<string, StoredOffer>(); keys = new Map<string, StoredOffer>(); accepted = new Map<string, AcceptedOffer>(); events: AcceptanceEvent[] = [];
  captures: unknown[] = []; declines = 0; rejected: string[] = []; rejectionDetails: { traceId: string; operation: string }[] = []; requests = new Map<string, StoredOfferRequest>();
  async request(a: OfferActor, key: string) { return this.requests.get(a.clientId + key) ?? null; }
  async quote(a: OfferActor, id: string) { return a.clientId === actor.clientId && a.subjectToken === actor.subjectToken && id === quote.quoteId ? quote : null; }
  async byKey(a: OfferActor, key: string) { return this.keys.get(a.clientId + key) ?? null; }
  async get(a: OfferActor, id: string) { const r = this.rows.get(id); return r?.terms.clientId === a.clientId && r.terms.subjectToken === a.subjectToken ? r : null; }
  async create(i: Parameters<OfferStore['create']>[0]) {
    const existing = this.requests.get(i.actor.clientId + i.key); if (existing) return { created: false, request: existing };
    const request: StoredOfferRequest = { actor: i.actor, requestIdentity: i.requestIdentity, outcome: 'accepted', offer: i.offer };
    this.captures.push(structuredClone(i.capture)); this.rows.set(i.offer.terms.offerId, structuredClone(i.offer)); this.keys.set(i.actor.clientId + i.key, i.offer); this.requests.set(i.actor.clientId + i.key, request);
    return { created: true, request };
  }
  async decline(i: Parameters<OfferStore['decline']>[0]) {
    const existing = this.requests.get(i.actor.clientId + i.key); if (existing) return { created: false, request: existing };
    const request: StoredOfferRequest = { actor: i.actor, requestIdentity: i.requestIdentity, outcome: 'declined' };
    this.requests.set(i.actor.clientId + i.key, request); this.declines++; return { created: true, request };
  }
  async acceptance(a: OfferActor, key: string) { return this.accepted.get(a.clientId + key) ?? null; }
  async accept(i: Parameters<OfferStore['accept']>[0]): ReturnType<OfferStore['accept']> {
    const previous = this.accepted.get(i.actor.clientId + i.key);
    if (previous) return previous.offerId === i.acceptance.offerId ? { status: 'replayed', acceptance: previous } : { status: 'conflict' };
    if ([...this.accepted.values()].some(x => x.offerId === i.acceptance.offerId)) return { status: 'conflict' };
    this.accepted.set(i.actor.clientId + i.key, i.acceptance); this.events.push(i.event); return { status: 'created', acceptance: i.acceptance };
  }
  async reject(_a: OfferActor, _id: string, traceId: string, reason: string, operation = 'offer.accept') { this.rejected.push(reason); this.rejectionDetails.push({ traceId, operation }); }
}
class MemorySnapshots implements SignalSnapshots {
  rows = new Map<string, SignalSnapshot>();
  async find(_subjectToken: string, scope: typeof SIGNAL_SCOPES[number]) { return this.rows.get(scope) ?? null; }
  async save(snapshot: Parameters<SignalSnapshots['save']>[0]) { this.rows.set(snapshot.signal.scope, snapshot); }
}
function signalReader(provider: SignalProvider, snapshots: SignalSnapshots, now: () => Date) {
  return new ReadSignal({ guard: { verify: async () => ({ allowed: false, reason: 'unavailable' }) }, provider, snapshots, clock: { now },
    timer: { after: () => new Promise<void>(() => {}) }, trace: { record: () => {} } });
}
function fixture() {
  let now = new Date('2026-10-16T10:00:00.000Z');
  const store = new MemoryOffers(), integrity = new HmacOfferIntegrity('synthetic-unit-financial-key-'.padEnd(40, 'x'));
  const provider = new MockRiskSignals(() => now), snapshots = new MemorySnapshots(), flights = new MockFlightSchedule(() => now);
  const deps = { store, integrity, provider, signals: signalReader(provider, snapshots, () => now), snapshots, flights, clock: { now: () => now }, environment: 'local', enabled: true };
  const service = new OfferService(deps);
  const command = { actor, authorization, idempotencyKey: 'create-1', quoteId: quote.quoteId, traceId: randomUUID() };
  return { deps, service, store, command, setNow: (date: string) => { now = new Date(date); } };
}
test('a saved quote becomes a separate definitive offer only after fresh consent and all mock signals', async () => {
  const f = fixture(), result = await f.service.create(f.command);
  assert.equal(result.status, 'created'); if (result.status !== 'created') throw Error('unreachable');
  assert.equal(result.offer.premium, '77760.0000'); assert.equal(result.offer.ruleVersion, 'academic-mortgage-1');
  assert.equal(result.offer.expiresAt, '2026-10-16T10:15:00.000Z'); assert.equal(result.offer.synthetic, true);
  const replay = await f.service.create(f.command); assert.equal(replay.status, 'replayed');
  assert.equal((await f.service.create({ ...f.command, quoteId: 'COT-2026-00002' })).status, 'conflict');
  assert.equal((await f.service.create({ ...f.command, actor: other })).status, 'not_found');
});
test('expired or absent authorization prevents all provider use and persistence', async () => {
  const f = fixture(); let calls = 0; f.deps.provider.read = async () => { calls++; throw Error('must not call'); };
  assert.equal((await f.service.create({ ...f.command, authorization: { ...authorization, expiresAt: '2026-10-16T09:00:00.000Z' } })).status, 'denied');
  assert.equal(calls, 0); assert.equal(f.store.rows.size, 0);
});
test('invalid or stale signals cannot create an offer, while a failed source creates only a preliminary one', async () => {
  for (const bad of ['error', 'stale', 'missing'] as const) {
    const f = fixture(); const original = f.deps.provider.read.bind(f.deps.provider);
    f.deps.provider.read = async (s, scope, t) => { const signal = await original(s, scope, t); if (scope !== 'payment_history_score') return signal;
      if (bad === 'error') throw Error('provider down'); return { ...signal, capturedAt: bad === 'stale' ? '2026-10-15T10:00:00.000Z' : signal.capturedAt, data: bad === 'missing' ? {} : signal.data }; };
    const result = await f.service.create(f.command);
    if (bad === 'error') {
      assert.equal(result.status, 'created');
      if (result.status === 'created') assert.equal(result.offer.status, 'preliminary');
      assert.equal(f.store.rows.size, 1);
    } else { assert.equal(result.status, 'unavailable'); assert.equal(f.store.rows.size, 0); }
  }
});
test('every normalized provider failure on any scope produces a non-acceptable preliminary offer', async () => {
  for (const code of PROVIDER_FAILURES) for (const failing of SIGNAL_SCOPES) {
    const f = fixture(); const original = f.deps.provider.read.bind(f.deps.provider);
    f.deps.provider.read = async (s, scope, t) => { if (scope === failing) throw new ProviderFailure(code); return original(s, scope, t); };
    const result = await f.service.create(f.command);
    assert.equal(result.status, 'created', `${code} on ${failing}`);
    if (result.status !== 'created') throw Error('unreachable');
    assert.equal(result.offer.status, 'preliminary');
    const capture = f.store.captures[0] as { outcome: string; sources: { source: string; degraded: boolean; failure?: string; substitute?: string; confidence?: number }[] };
    const degraded = capture.sources.find(source => source.degraded);
    assert.deepEqual({ outcome: capture.outcome, source: degraded?.source, failure: degraded?.failure, substitute: degraded?.substitute, confidence: degraded?.confidence },
      { outcome: 'preliminary', source: `signal:${failing}`, failure: code, substitute: 'default', confidence: 0 });
    assert.equal((await f.service.accept({ ...f.command, offerId: result.offer.offerId, idempotencyKey: `accept-${code}-${failing}` })).status, 'conflict');
    assert.equal(f.store.rows.size, 1); assert.equal(f.store.declines, 0); assert.equal(f.store.events.length, 0);
  }
});
test('a current same-consent snapshot is used for a preliminary offer and records reduced confidence', async () => {
  const f = fixture();
  const first = await f.service.create(f.command); assert.equal(first.status, 'created');
  const original = f.deps.provider.read.bind(f.deps.provider);
  f.deps.provider.read = async (subject, scope, trace) => scope === 'payment_history_score'
    ? Promise.reject(new ProviderFailure('timeout')) : original(subject, scope, trace);
  const second = await f.service.create({ ...f.command, idempotencyKey: 'create-from-copy' });
  assert.equal(second.status, 'created'); if (second.status !== 'created') throw Error('unreachable');
  assert.equal(second.offer.status, 'preliminary');
  const capture = f.store.captures[1] as { sources: { source: string; substitute?: string; confidence?: number }[] };
  assert.deepEqual(capture.sources.find(source => source.source === 'signal:payment_history_score'), {
    source: 'signal:payment_history_score', capturedAt: '2026-10-16T10:00:00.000Z', quality: 'stored_copy', degraded: true,
    confidence: 60, failure: 'timeout', substitute: 'stored_copy'
  });
});
test('underwriting declines excessive obligations and records the actual decision', async () => {
  const f = fixture(); const original = f.deps.provider.read.bind(f.deps.provider);
  f.deps.provider.read = async (s, scope, t) => scope === 'income_obligations_12m' ? { scope, capturedAt: f.deps.clock.now().toISOString(), data: { monthlyIncomeCop: 8000000, monthlyObligationsCop: 5000000 } } : original(s, scope, t);
  assert.equal((await f.service.create(f.command)).status, 'declined'); assert.equal(f.store.declines, 1); assert.equal(f.store.rows.size, 0);
});
test('expiry while reading providers blocks persistence even after authorization succeeded', async () => {
  const f = fixture(); const original = f.deps.provider.read.bind(f.deps.provider);
  f.deps.provider.read = async (s, scope, t) => { const value = await original(s, scope, t); f.setNow('2026-10-16T12:01:00.000Z'); return value; };
  assert.equal((await f.service.create(f.command)).status, 'denied'); assert.equal(f.store.rows.size, 0);
});
test('acceptance emits the exact Policy contract and same-key replay produces one event', async () => {
  const f = fixture(), created = await f.service.create(f.command); assert.equal(created.status, 'created'); if (created.status !== 'created') throw Error('unreachable');
  const command = { ...f.command, offerId: created.offer.offerId, idempotencyKey: 'accept-1' };
  assert.equal((await f.service.accept(command)).status, 'created'); assert.equal((await f.service.accept(command)).status, 'replayed'); assert.equal(f.store.events.length, 1);
  const event = f.store.events[0]; assert.equal(isOfferEnvelope(event, 'local'), true);
  if (!isOfferEnvelope(event, 'local')) throw Error('invalid boundary');
  assert.equal(acceptanceContent(event), eventContent(event)); assert.equal(await f.deps.integrity.verifyEvent(event), true);
  assert.equal(await f.deps.integrity.verifyEvent({ ...event, payload: { ...event.payload, premium: '1.0000' } }), false);
  assert.equal((await f.service.accept({ ...command, authorization: undefined })).status, 'denied', 'replay requires fresh consent too');
  assert.equal((await f.service.accept({ ...command, authorization: { ...authorization, consentId: 'CNS-2026-00002' } })).status, 'denied', 'a new consent cannot authorize reuse of sources from another consent');
  assert.equal((await f.service.accept({ ...command, actor: other })).status, 'not_found');
});
test('tampered persisted terms, changed consent provenance and expired offers cause no financial event', async () => {
  for (const mode of ['tamper', 'consent', 'expiry'] as const) {
    const f = fixture(), created = await f.service.create(f.command); if (created.status !== 'created') throw Error('unreachable');
    const auth = { ...authorization };
    if (mode === 'tamper') f.store.rows.get(created.offer.offerId)!.terms.premium = '1.0000';
    else if (mode === 'consent') { auth.consentId = 'CNS-2026-00002'; f.store.rows.get(created.offer.offerId)!.consentId = auth.consentId; }
    else f.setNow('2026-10-16T10:15:00.000Z');
    assert.equal((await f.service.accept({ ...f.command, authorization: auth, offerId: created.offer.offerId })).status, mode !== 'expiry' ? 'integrity_invalid' : 'expired');
    assert.equal(f.store.events.length, 0); assert.equal(f.store.accepted.size, 0); assert.deepEqual(f.store.rejected, [mode !== 'expiry' ? 'integrity_invalid' : 'expired']);
  }
});
test('flight offers use their own mock source and fixed academic terms without borrowing a mortgage quote', async () => {
  const f = fixture(); const input = { actor, flightReference: randomUUID(), idempotencyKey: 'flight', traceId: randomUUID() };
  f.deps.provider.read = async () => { throw Error('financial source must not be called'); };
  const r = await f.service.createFlight(input); assert.equal(r.status, 'created'); if (r.status !== 'created') throw Error('unreachable');
  assert.equal(r.offer.quoteId, null); assert.equal(r.offer.premium, '10000.0000'); assert.equal(r.offer.coverage.kind, 'flight_delay');
  assert.equal((await f.service.createFlight(input)).status, 'replayed');
  assert.equal((await f.service.createFlight({ ...input, flightReference: randomUUID() })).status, 'conflict');
  assert.equal((await f.service.accept({ actor, offerId: r.offer.offerId, idempotencyKey: 'accept-flight', traceId: randomUUID() })).status, 'created');
});
test('disabled provider mode never invokes sources or stores an offer', async () => {
  const f = fixture(); f.deps.enabled = false;
  assert.equal((await f.service.create(f.command)).status, 'unavailable');
  assert.equal(f.store.rows.size, 0);
});
test('deployed composition refuses production or any mode other than explicit mock', async () => {
  for (const [APP_ENV, FINANCIAL_PROVIDER_MODE, FINANCIAL_EVENT_KEY] of [['prod', 'mock', 'x'.repeat(40)], ['dev', 'disabled', 'x'.repeat(40)], ['dev', 'mock', 'short']] as const) {
    const service = createOffers({ APP_ENV, FINANCIAL_PROVIDER_MODE, FINANCIAL_EVENT_KEY, ACQUISITION_DB: { connectionString: 'must-not-connect' } });
    assert.equal((await service.createFlight({ actor, flightReference: randomUUID(), idempotencyKey: 'test', traceId: randomUUID() })).status, 'unavailable');
  }
});
test('a late Queue acknowledgment cannot turn a timed-out publishing attempt into success', async () => {
  let acknowledge!: () => void;
  const transport = new Promise<void>(resolve => { acknowledge = resolve; });
  const attempt = sendWithinDeadline(transport, 5);
  await assert.rejects(attempt, /financial_queue_deadline$/);
  acknowledge(); await transport;
  await assert.rejects(attempt, /financial_queue_deadline$/, 'late completion leaves the original attempt failed');
  await sendWithinDeadline(Promise.resolve(), 5);
  await assert.rejects(sendWithinDeadline(Promise.reject(new Error('queue unavailable')), 5), /queue unavailable/);
});
test('changing lookup ownership cannot transfer an offer whose sealed owner is another actor', async () => {
  const f = fixture();
  const flightReference = randomUUID();
  const first = await f.service.createFlight({ actor, flightReference, idempotencyKey: 'victim-offer', traceId: randomUUID() });
  if (first.status !== 'created') throw Error('unreachable');
  const victim = f.store.rows.get(first.offer.offerId)!;
  // Simulate altered lookup columns; the financial terms and their valid HMAC still name the victim.
  f.store.get = async () => victim;
  f.store.byKey = async () => victim;
  const read = await f.service.get({ actor: other, offerId: victim.terms.offerId, traceId: randomUUID() });
  assert.equal(read.status, 'integrity_invalid'); assert.equal('offer' in read, false);
  assert.equal((await f.service.createFlight({ actor: other, flightReference, idempotencyKey: 'victim-offer', traceId: randomUUID() })).status, 'conflict');
  assert.equal((await f.service.accept({ actor: other, offerId: victim.terms.offerId, idempotencyKey: 'foreign-accept', traceId: randomUUID() })).status, 'integrity_invalid');
  assert.equal(f.store.accepted.size, 0); assert.equal(f.store.events.length, 0);
  // A concurrent insert winner must be checked too, not only the initial lookup.
  f.store.byKey = async () => null;
  f.store.create = async () => ({ created: false, request: { actor: other, requestIdentity: offerRequestIdentity('flight_delay', flightReference), outcome: 'accepted', offer: victim } });
  assert.equal((await f.service.createFlight({ actor: other, flightReference, idempotencyKey: 'race', traceId: randomUUID() })).status, 'conflict');
});

test('a declined first outcome replays without reading changed sources and rejects another request with the same key', async () => {
  const f = fixture(), original = f.deps.provider.read.bind(f.deps.provider);
  f.deps.provider.read = async (s, scope, t) => scope === 'income_obligations_12m'
    ? { scope, capturedAt: f.deps.clock.now().toISOString(), data: { monthlyIncomeCop: 8000000, monthlyObligationsCop: 5000000 } } : original(s, scope, t);
  assert.equal((await f.service.create(f.command)).status, 'declined');
  f.deps.provider.read = async () => { throw Error('replay must not call changed providers'); };
  assert.equal((await f.service.create(f.command)).status, 'declined');
  assert.equal((await f.service.create({ ...f.command, quoteId: 'COT-2026-00002' })).status, 'conflict');
  assert.equal((await f.service.createFlight({ actor, flightReference: randomUUID(), idempotencyKey: f.command.idempotencyKey, traceId: randomUUID() })).status, 'conflict');
  assert.equal(f.store.declines, 1); assert.equal(f.store.rows.size, 0); assert.equal(f.store.requests.size, 1);
});

test('concurrent accepted and declined underwriting share one first outcome', async () => {
  for (const declineFirst of [true, false]) {
    const f = fixture(), original = f.deps.provider.read.bind(f.deps.provider);
    const declinedProvider = { read: async (s: string, scope: typeof SIGNAL_SCOPES[number], t: string) => scope === 'income_obligations_12m'
      ? { scope, capturedAt: f.deps.clock.now().toISOString(), data: { monthlyIncomeCop: 8000000, monthlyObligationsCop: 5000000 } } : original(s, scope, t) };
    const declined = new OfferService({ ...f.deps, signals: signalReader(declinedProvider, new MemorySnapshots(), f.deps.clock.now) });
    const create = f.store.create.bind(f.store), decline = f.store.decline.bind(f.store);
    let release!: () => void; const firstWritten = new Promise<void>(resolve => { release = resolve; });
    f.store.create = async i => { if (declineFirst) await firstWritten; const result = await create(i); if (!declineFirst) release(); return result; };
    f.store.decline = async i => { if (!declineFirst) await firstWritten; const result = await decline(i); if (declineFirst) release(); return result; };
    const results = await Promise.all([f.service.create(f.command), declined.create(f.command)]);
    assert.equal(f.store.requests.size, 1);
    if (declineFirst) { assert.deepEqual(results.map(r => r.status), ['declined', 'declined']); assert.equal(f.store.rows.size, 0); assert.equal(f.store.declines, 1); }
    else { assert.deepEqual(results.map(r => r.status), ['created', 'replayed']); assert.equal(f.store.rows.size, 1); assert.equal(f.store.declines, 0); }
  }
});

test('offers created before the request ledger retain their original key and sealed ownership', async () => {
  const f = fixture(), created = await f.service.create(f.command); assert.equal(created.status, 'created');
  f.store.requests.clear();
  f.deps.provider.read = async () => { throw Error('legacy replay must not call sources'); };
  assert.equal((await f.service.create(f.command)).status, 'replayed');
  assert.equal((await f.service.createFlight({ actor, flightReference: randomUUID(), idempotencyKey: f.command.idempotencyKey, traceId: randomUUID() })).status, 'conflict');
});

test('reading altered sealed terms records the read trace and fails unavailable if the audit cannot persist', async () => {
  const f = fixture(), created = await f.service.create(f.command); if (created.status !== 'created') throw Error('unreachable');
  f.store.rows.get(created.offer.offerId)!.terms.premium = '1.0000';
  const traceId = randomUUID(), read = await f.service.get({ actor, offerId: created.offer.offerId, traceId });
  assert.equal(read.status, 'integrity_invalid'); assert.equal('offer' in read, false);
  assert.deepEqual(f.store.rejectionDetails, [{ traceId, operation: 'offer.read' }]);
  f.store.reject = async () => { throw Error('audit unavailable'); };
  assert.equal((await f.service.get({ actor, offerId: created.offer.offerId, traceId: randomUUID() })).status, 'unavailable');
});
