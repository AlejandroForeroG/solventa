import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Inbox, IndemnityNotice, FinancialStore, FinancialTransaction, Payment, PaymentGateway, StoredPolicy } from '../backend/policy-claims-payments/src/application/ports/financial';
import { PolicyFinance } from '../backend/policy-claims-payments/src/application/policy-finance';
import { MockParametricEventProvider } from '../backend/policy-claims-payments/src/adapters/outbound/mock-parametric-provider';
import type { ProviderReading } from '../backend/policy-claims-payments/src/adapters/outbound/mock-parametric-provider';
import { issuanceTimeContent, offerContent, paymentContent, policyDocument } from '../backend/policy-claims-payments/src/domain/financial';
import { acceptedOffer, financialIntegrity, financialNow, providerEvent } from './financial-fixtures';

type Product = 'vida_hipotecario' | 'flight_delay' | 'weather_event';
type SettleAnswer = 'confirmed' | 'declined' | 'uncertain';
const SIGNED_AT = '2026-10-16T02:05:00.000Z';

// Narrow in-memory owner: SQL atomicity, grants and rollback are exercised by financial-smoke.mts.
async function fixture(product: Product = 'weather_event', options: { now?: string; settle?: () => SettleAnswer } = {}) {
  const offer = (await acceptedOffer(product)).payload, id = randomUUID(), document = policyDocument(id, offer);
  const policy: StoredPolicy = { id, clientId: offer.clientId, subjectToken: offer.subjectToken, status: 'issued', offer,
    termsHash: await financialIntegrity.digest(offerContent(offer)), document, documentHash: await financialIntegrity.digest(document),
    premium: offer.premium, currency: 'COP', offerId: offer.offerId, offerVersion: offer.offerVersion,
    effectiveFrom: offer.effectiveFrom, effectiveUntil: offer.effectiveUntil, coverageSnapshot: offer.coverage };
  const premium: Payment = { id: randomUUID(), policyId: id, operation: 'premium', key: 'initial-premium', amount: policy.premium, currency: 'COP', hash: '',
    status: 'confirmed', providerReference: null };
  premium.providerReference = 'MOCK-' + premium.id;
  premium.hash = await financialIntegrity.digest(paymentContent(premium));
  const signature = { documentHash: policy.documentHash, signedAt: SIGNED_AT,
    receipt: await financialIntegrity.digest(JSON.stringify(['mock-signature-v1', id, policy.documentHash])),
    timeSeal: await financialIntegrity.digest(issuanceTimeContent(id, policy.documentHash, SIGNED_AT)) };

  let indemnity: Payment | null = null, claims = 0, settles = 0;
  const inbox = new Map<string, Inbox & { eventType: string }>(), audits: Array<{ action: string; capture: unknown }> = [], notices: IndemnityNotice[] = [], rejections: string[] = [];
  const held = new Set<string>();
  const tx = {
    async policy() { return { policy, premium, signature }; },
    async payment(_id: string, operation: 'premium' | 'indemnity') { return operation === 'premium' ? premium : indemnity; },
    async createPayment(payment: Payment) { indemnity = payment; claims++; },
    async setPaymentStatus(_id: string, status: Payment['status'], reference: string | null) { if (indemnity) indemnity = { ...indemnity, status, providerReference: reference }; },
    async inbox(eventId: string) { return inbox.get(eventId) ?? null; },
    async recordInbox(eventId: string, _consumer: string, hash: string, policyId: string, eventType: string) { inbox.set(eventId, { hash, policyId, outcome: 'accepted', eventType }); },
    async audit(action: string, _id: string, _trace: string, _outcome: string, _actor: string, capture: unknown) { audits.push({ action, capture }); },
    async announceIndemnity(notice: IndemnityNotice) { notices.push(notice); }
  } as unknown as FinancialTransaction;
  const store = { async transaction<T>(work: (transaction: FinancialTransaction) => Promise<T>) { return work(tx); },
    async rejection(_id: string, _trace: string, cause: string) { rejections.push(cause); },
    // Like the SQL store, the stored evidence comes from the capture written when the event was accepted.
    async pendingIndemnities() {
      const [eventId, event] = [...inbox.entries()][0] ?? [];
      const accepted = audits.find(entry => entry.action === 'parametric.accepted')?.capture as { inputs: { event: unknown }; sources: unknown[] } | undefined;
      return indemnity?.status === 'pending' && event && eventId && accepted
        ? [{ policyId: id, eventId, eventType: event.eventType, occurredAt: '2026-10-16T02:30:00.000Z', event: accepted.inputs.event, sources: accepted.sources }] : [];
    } } as unknown as FinancialStore;
  const gateway: PaymentGateway = {
    async settle(payment) {
      settles++;
      const answer = options.settle?.() ?? 'confirmed';
      if (answer !== 'confirmed') return { status: answer, reference: null };
      held.add(payment.id);
      return { status: 'confirmed', reference: 'MOCK-' + payment.id };
    },
    async lookup(payment) { return held.has(payment.id) ? { status: 'confirmed', reference: 'MOCK-' + payment.id } : { status: 'unknown', reference: null }; },
    async refund() { throw new Error('unexpected_refund'); } };
  const dependencies = { enabled: true, environment: 'local' as const, integrity: financialIntegrity, store, payments: gateway,
    signatures: { async sign() { throw new Error('unexpected_signature'); } }, parametric: new MockParametricEventProvider(financialIntegrity, 'local'),
    now: () => new Date(options.now ?? '2026-10-16T03:00:00.000Z'), newId: randomUUID };
  const finance = new PolicyFinance(dependencies);
  const coverage = offer.coverage;
  const reading: ProviderReading = coverage.kind === 'weather_event' ? { kind: 'weather_precipitation', stationId: coverage.stationId, precipitationMm: 50 }
    : coverage.kind === 'flight_delay' ? { kind: 'flight_delay', flightReference: coverage.flightReference, delayMinutes: 180 }
      : { kind: 'weather_precipitation', stationId: randomUUID(), precipitationMm: 50 };
  return { finance, dependencies, policy, reading, held, state: { claims: () => claims, settles: () => settles, indemnity: () => indemnity, audits, notices, rejections },
    // An explicit argument, even null, is sent as given; only a call without one sends a valid event.
    receive: async (...given: unknown[]) => finance.receiveParametricEvent(given.length ? given[0] : await providerEvent(id, reading), randomUUID()) };
}

const denied = (result: { status: string }, error: string, httpStatus = 409) => assert.deepEqual(result, { ...result, status: 'denied', error, httpStatus });
const noEffect = (fixtureState: Awaited<ReturnType<typeof fixture>>['state']) => {
  assert.equal(fixtureState.claims(), 0);
  assert.equal(fixtureState.settles(), 0);
  assert.deepEqual(fixtureState.notices, []);
  assert.deepEqual(fixtureState.audits.map(entry => entry.action), []);
};

test('a verified rainfall event at the threshold pays the weather policy once and notifies its owner', async () => {
  const { receive, policy, state } = await fixture('weather_event');
  const result = await receive();
  assert.ok(result.status === 'ok', JSON.stringify(result));
  assert.equal(result.replayed, false);
  assert.deepEqual(Object.keys(result).sort(), ['indemnity', 'policyId', 'replayed', 'status'], 'the provider boundary never receives the document or its hash');
  assert.equal(result.policyId, policy.id);
  assert.match(result.indemnity.reference, /^MOCK-/);
  assert.equal(state.indemnity()?.status, 'confirmed');
  assert.equal(state.indemnity()?.amount, '100000.0000');
  assert.deepEqual(state.audits.map(entry => entry.action), ['parametric.accepted', 'indemnity.confirmed']);
  assert.equal(state.notices.length, 1);
  assert.deepEqual(state.notices[0], { paymentId: state.indemnity()?.id, policyId: policy.id, clientId: policy.clientId, coverageKind: 'weather_event',
    confirmedAt: '2026-10-16T03:00:00.000Z' });
});

test('the same engine pays the flight-delay variant', async () => {
  const { receive, policy, state } = await fixture('flight_delay');
  const result = await receive();
  assert.ok(result.status === 'ok', JSON.stringify(result));
  assert.equal(state.indemnity()?.status, 'confirmed');
  assert.equal(state.notices[0]?.coverageKind, 'flight_delay');
  assert.equal(state.notices[0]?.clientId, policy.clientId);
});

test('an occurrence that does not match the coverage creates no claim, payment or notice', async () => {
  const cases: Array<[string, Product, (reading: ProviderReading, policy: StoredPolicy) => ProviderReading]> = [
    ['rain below the threshold', 'weather_event', reading => reading.kind === 'weather_precipitation' ? { ...reading, precipitationMm: 49 } : reading],
    ['another station', 'weather_event', reading => reading.kind === 'weather_precipitation' ? { ...reading, stationId: randomUUID() } : reading],
    ['a flight event on a weather policy', 'weather_event', () => ({ kind: 'flight_delay', flightReference: randomUUID(), delayMinutes: 600 })],
    ['a delay below the threshold', 'flight_delay', reading => reading.kind === 'flight_delay' ? { ...reading, delayMinutes: 179 } : reading],
    ['another flight', 'flight_delay', reading => reading.kind === 'flight_delay' ? { ...reading, flightReference: randomUUID() } : reading],
    ['a rain event on a flight policy', 'flight_delay', () => ({ kind: 'weather_precipitation', stationId: randomUUID(), precipitationMm: 500 })],
    ['a parametric event on a mortgage policy', 'vida_hipotecario', () => ({ kind: 'weather_precipitation', stationId: randomUUID(), precipitationMm: 500 })]
  ];
  for (const [label, product, change] of cases) {
    const { receive, policy, reading, state } = await fixture(product);
    denied(await receive(await providerEvent(policy.id, change(reading, policy))), 'event_not_covered');
    assert.equal(state.claims(), 0, label);
    assert.equal(state.settles(), 0, label);
    assert.deepEqual(state.notices, [], label);
    assert.deepEqual(state.rejections, ['event_not_covered'], label);
  }
});

test('an event outside the issued coverage period is not covered', async () => {
  const before = await fixture('weather_event');
  denied(await before.receive(await providerEvent(before.policy.id, before.reading, { observedAt: '2026-10-16T02:01:00.000Z' })), 'event_not_covered');
  noEffect(before.state);
  const after = await fixture('weather_event', { now: '2026-10-18T00:00:00.000Z' });
  denied(await after.receive(await providerEvent(after.policy.id, after.reading, { observedAt: '2026-10-17T02:00:00.000Z' })), 'event_not_covered');
  noEffect(after.state);
});

test('invalid, altered or foreign provider events never reach the payment engine', async () => {
  const { receive, policy, reading, state } = await fixture('weather_event');
  const valid = await providerEvent(policy.id, reading);
  const invalid: unknown[] = [
    { ...valid, signature: 'a'.repeat(64) },
    { ...valid, reading: { ...valid.reading, precipitationMm: 51 } },
    { ...valid, policyId: randomUUID() },
    { ...valid, environment: 'prod' },
    { ...valid, synthetic: false },
    { ...valid, unexpected: 'field' },
    { ...valid, version: 2 },
    { ...valid, signature: undefined },
    { ...valid, reading: { kind: 'earthquake', magnitude: 7 } },
    await providerEvent(policy.id, { kind: 'weather_precipitation', stationId: 'not-a-uuid', precipitationMm: 50 }),
    await providerEvent(policy.id, { kind: 'weather_precipitation', stationId: reading.kind === 'weather_precipitation' ? reading.stationId : '', precipitationMm: 50.5 }),
    await providerEvent(policy.id, { kind: 'weather_precipitation', stationId: reading.kind === 'weather_precipitation' ? reading.stationId : '', precipitationMm: -1 }),
    await providerEvent(policy.id, reading, { observedAt: '2026-10-16T05:00:00.000Z' }),
    null, 'text', []
  ];
  for (const [index, event] of invalid.entries()) {
    const result = await receive(event);
    assert.ok(result.status === 'denied' && result.error === 'invalid_event' && result.httpStatus === 400, `case ${index}: ${JSON.stringify(result)}`);
  }
  noEffect(state);
  assert.equal(state.rejections.length, invalid.length, 'each rejection is audited');
});

test('a replayed event keeps one effect and the same identity, and a different content under it is a conflict', async () => {
  const { receive, policy, reading, state } = await fixture('weather_event');
  const event = await providerEvent(policy.id, reading);
  const first = await receive(event), replay = await receive(event);
  assert.ok(first.status === 'ok' && !first.replayed);
  assert.ok(replay.status === 'ok' && replay.replayed);
  assert.equal(replay.status === 'ok' && replay.indemnity.reference, first.status === 'ok' && first.indemnity.reference);
  assert.equal(state.claims(), 1);
  assert.equal(state.settles(), 1);
  assert.equal(state.notices.length, 1, 'a replay never announces the payment twice');
  const sameIdentityOtherData = await providerEvent(policy.id, reading.kind === 'weather_precipitation' ? { ...reading, precipitationMm: 80 } : reading, { providerEventId: event.providerEventId });
  denied(await receive(sameIdentityOtherData), 'event_conflict');
  const secondOccurrence = await providerEvent(policy.id, reading);
  denied(await receive(secondOccurrence), 'event_conflict');
  assert.equal(state.claims(), 1);
  assert.equal(state.notices.length, 1);
});

test('an uncertain provider result is neither paid nor announced, and a retry completes it without duplication', async () => {
  let answer: SettleAnswer = 'uncertain';
  const { receive, policy, reading, state } = await fixture('weather_event', { settle: () => answer });
  const event = await providerEvent(policy.id, reading);
  assert.equal((await receive(event)).status, 'unavailable');
  assert.equal(state.indemnity()?.status, 'pending');
  assert.deepEqual(state.notices, []);
  assert.deepEqual(state.audits.map(entry => entry.action), ['parametric.accepted']);
  answer = 'confirmed';
  const retried = await receive(event);
  assert.ok(retried.status === 'ok' && retried.replayed);
  assert.equal(state.claims(), 1);
  assert.equal(state.notices.length, 1);
  assert.equal(state.indemnity()?.status, 'confirmed');
});

test('the scheduled recovery confirms a pending indemnity once, with its notice, and a second run finds nothing', async () => {
  let answer: SettleAnswer = 'uncertain';
  const { receive, policy, reading, finance, state } = await fixture('weather_event', { settle: () => answer });
  assert.equal((await receive(await providerEvent(policy.id, reading))).status, 'unavailable');
  const [stillPending, ...none] = await finance.reconcileIndemnities(new Date(), 10);
  assert.equal(stillPending?.outcome, 'unavailable');
  assert.deepEqual(none, []);
  assert.deepEqual(state.notices, []);
  answer = 'confirmed';
  const [recovered, ...others] = await finance.reconcileIndemnities(new Date(), 10);
  assert.equal(recovered?.outcome, 'confirmed');
  assert.deepEqual(others, []);
  assert.equal(state.indemnity()?.status, 'confirmed');
  assert.equal(state.notices.length, 1);
  const confirmed = state.audits.filter(entry => entry.action === 'indemnity.confirmed');
  assert.equal(confirmed.length, 1);
  const capture = confirmed[0].capture as { inputs: { trigger?: string; event: { precipitationMm?: number } }; sources: Array<{ source: string }> };
  assert.equal(capture.inputs.trigger, 'reconciliation');
  assert.equal(capture.inputs.event.precipitationMm, 50, 'the recovered decision keeps the measurement that justified the payout');
  assert.ok(capture.sources.some(source => source.source === 'synthetic-parametric-provider-v1'), 'and the authenticated provider that reported it');
  assert.deepEqual(await finance.reconcileIndemnities(new Date(), 10), []);
  assert.equal(state.claims(), 1);
});

test('recovery continues a charge the provider already holds without settling it again', async () => {
  const { receive, policy, reading, finance, state, held } = await fixture('weather_event', { settle: () => 'uncertain' });
  assert.equal((await receive(await providerEvent(policy.id, reading))).status, 'unavailable');
  const settlesBefore = state.settles();
  const paymentId = state.indemnity()?.id;
  assert.ok(paymentId);
  held.add(paymentId);
  const [recovered] = await finance.reconcileIndemnities(new Date(), 10);
  assert.equal(recovered?.outcome, 'confirmed');
  assert.equal(state.settles(), settlesBefore, 'a charge the provider confirmed is looked up, never repeated');
  assert.equal(state.notices.length, 1);
});

test('a declined indemnity payment is recorded as declined, never announced, and neither a replay nor the recovery tries it again', async () => {
  const { receive, policy, reading, finance, state } = await fixture('weather_event', { settle: () => 'declined' });
  const event = await providerEvent(policy.id, reading);
  denied(await receive(event), 'payment_declined');
  assert.equal(state.indemnity()?.status, 'declined');
  assert.deepEqual(state.notices, []);
  const declined = state.audits.filter(entry => entry.action === 'indemnity.declined');
  assert.equal(declined.length, 1);
  assert.equal((declined[0].capture as { outcome: string }).outcome, 'declined');
  assert.equal(state.settles(), 1);
  denied(await receive(event), 'payment_declined');
  assert.deepEqual(await finance.reconcileIndemnities(new Date(), 10), []);
  assert.equal(state.settles(), 1, 'a terminal decline is not sent to the gateway again');
  assert.equal(state.audits.filter(entry => entry.action === 'indemnity.declined').length, 1);
});

test('a disabled service neither pays nor recovers', async () => {
  const { dependencies, policy, reading } = await fixture('weather_event');
  const off = new PolicyFinance({ ...dependencies, enabled: false });
  assert.equal((await off.receiveParametricEvent(await providerEvent(policy.id, reading), randomUUID())).status, 'unavailable');
  assert.deepEqual(await off.reconcileIndemnities(new Date(), 10), []);
});
