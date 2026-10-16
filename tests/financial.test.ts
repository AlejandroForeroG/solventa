import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eventContent, eventWithinIssuedCoverage, isOfferEnvelope, isParametricEnvelope, issuanceTimeContent, money, offerContent, paymentContent, policyDocument } from '../backend/policy-claims-payments/src/domain/financial';
import type { FinancialTransaction, Payment, PaymentGateway, StoredPolicy } from '../backend/policy-claims-payments/src/application/ports/financial';
import { PolicyFinance } from '../backend/policy-claims-payments/src/application/policy-finance';
import { acceptedOffer, financialIntegrity, financialNow, flightEvent } from './financial-fixtures';
import { createPolicyFinance } from '../backend/policy-claims-payments/src/adapters/composition';

test('financial amounts preserve DECIMAL(19,4) exactly without accepting floats, exponent or overflow', () => {
  for (const value of ['0.0001', '999999999999999.9999', '86400.0000']) assert.equal(money(value), true);
  for (const value of [86400, '86400', '1e4', '-1.0000', '01.0000', '0.0000', '1000000000000000.0000', '1.00001']) assert.equal(money(value), false);
  assert.equal(money('0.0000', false), true);
});

test('only a complete synthetic accepted offer from this environment reaches the policy boundary', async () => {
  const event = await acceptedOffer();
  assert.equal(isOfferEnvelope(event, 'local'), true);
  assert.equal(isOfferEnvelope(event, 'dev'), false);
  assert.equal(isOfferEnvelope({ ...event, synthetic: false }, 'local'), false);
  assert.equal(isOfferEnvelope({ ...event, payload: { ...event.payload, status: 'definitive' } }, 'local'), false);
  assert.equal(isOfferEnvelope({ ...event, payload: { ...event.payload, acceptedAt: event.payload.expiresAt } }, 'local'), false);
  assert.equal(isOfferEnvelope({ ...event, payload: { ...event.payload, premium: '86400' } }, 'local'), false);
});

test('canonical event authentication binds every identifier, term and routing environment independently of property order', async () => {
  const event = await acceptedOffer();
  assert.equal(await financialIntegrity.verify(eventContent(event), event.signature), true);
  const reordered = { ...event, payload: Object.fromEntries(Object.entries(event.payload).reverse()) };
  assert.equal(isOfferEnvelope(reordered, 'local'), true);
  if (!isOfferEnvelope(reordered, 'local')) throw new Error('invalid_fixture');
  assert.equal(eventContent(reordered), eventContent(event));
  for (const changed of [{ ...event, eventId: randomUUID() }, { ...event, environment: 'dev' as const },
    { ...event, payload: { ...event.payload, premium: '1.0000' } }, { ...event, payload: { ...event.payload, clientId: randomUUID() } }]) {
    assert.equal(await financialIntegrity.verify(eventContent(changed), event.signature), false);
  }
});

test('a flight event has bounded typed input and does not accept caller amounts or a different type', async () => {
  const event = await flightEvent(randomUUID(), randomUUID());
  assert.equal(isParametricEnvelope(event, 'local'), true);
  assert.equal(isParametricEnvelope({ ...event, payload: { ...event.payload, amount: '100000.0000' } }, 'local'), false);
  assert.equal(isParametricEnvelope({ ...event, eventType: 'death.reported' }, 'local'), false);
  assert.equal(isParametricEnvelope({ ...event, payload: { ...event.payload, delayMinutes: 180.5 } }, 'local'), false);
});

test('a payment intent binds the provider idempotency identity, operation and key as well as money', async () => {
  const intent = { id: randomUUID(), policyId: randomUUID(), operation: 'premium' as const, key: 'initial-premium', amount: '86400.0000', currency: 'COP' as const };
  const hash = await financialIntegrity.digest(paymentContent(intent));
  for (const changed of [{ ...intent, id: randomUUID() }, { ...intent, key: 'other' }, { ...intent, operation: 'indemnity' as const }, { ...intent, amount: '1.0000' }]) {
    assert.equal(await financialIntegrity.verify(paymentContent(changed), hash), false);
  }
});

test('a verified event cannot insure an occurrence before issuance even when offer coverage already started', async () => {
  const from = '2026-10-16T02:00:00.000Z', issuedAt = '2026-10-16T02:01:00.000Z', until = '2026-10-17T02:00:00.000Z';
  assert.equal(eventWithinIssuedCoverage(from, issuedAt, from, until), false);
  assert.equal(eventWithinIssuedCoverage(issuedAt, issuedAt, from, until), true);
  assert.equal(eventWithinIssuedCoverage(until, issuedAt, from, until), false);
  const id = randomUUID(), documentHash = '0'.repeat(64);
  const timeSeal = await financialIntegrity.digest(issuanceTimeContent(id, documentHash, issuedAt));
  assert.equal(await financialIntegrity.verify(issuanceTimeContent(id, documentHash, from), timeSeal), false);
});

test('disabled configuration and failure to persist a required rejection both fail closed', async () => {
  let calls = 0;
  const deps = { enabled: false, environment: 'local' as const, integrity: financialIntegrity, now: financialNow, newId: randomUUID,
    store: { async transaction<T>(): Promise<T> { throw new Error('not_expected'); }, async rejection() { calls++; throw new Error('sql_unavailable'); } },
    payments: { async settle() { throw new Error('not_expected'); }, async lookup() { throw new Error('not_expected'); }, async refund() { throw new Error('not_expected'); } },
    signatures: { async sign() { throw new Error('not_expected'); } } };
  assert.equal((await new PolicyFinance(deps).acceptOffer({}, randomUUID())).status, 'unavailable');
  assert.equal(calls, 0);
  assert.equal((await new PolicyFinance({ ...deps, enabled: true }).acceptOffer({}, randomUUID())).status, 'unavailable');
  assert.equal(calls, 1);
});

test('the deployed financial composition rejects missing or malformed hexadecimal key custody', async () => {
  for (const key of [undefined, '', 'a'.repeat(32), 'g'.repeat(64), 'A'.repeat(64)]) {
    const finance = createPolicyFinance({ APP_ENV: 'dev', FINANCIAL_PROVIDER_MODE: 'mock', FINANCIAL_EVENT_KEY: key,
      POLICY_DB: { connectionString: 'unused' } });
    assert.equal((await finance.acceptOffer({}, randomUUID())).status, 'unavailable');
  }
});

async function stateFixture(policyStatus: StoredPolicy['status'], paymentStatus: Payment['status'], known: Awaited<ReturnType<PaymentGateway['lookup']>>) {
  const offer = (await acceptedOffer()).payload, id = randomUUID();
  const document = policyDocument(id, offer);
  const policy: StoredPolicy = { id, clientId: offer.clientId, subjectToken: offer.subjectToken, status: policyStatus, offer,
    termsHash: await financialIntegrity.digest(offerContent(offer)), document, documentHash: await financialIntegrity.digest(document),
    premium: offer.premium, currency: 'COP', offerId: offer.offerId, offerVersion: offer.offerVersion,
    effectiveFrom: offer.effectiveFrom, effectiveUntil: offer.effectiveUntil, coverageSnapshot: offer.coverage };
  const payment: Payment = { id: randomUUID(), policyId: id, operation: 'premium', key: 'initial-premium', amount: offer.premium,
    currency: 'COP', hash: '', status: paymentStatus, providerReference: paymentStatus === 'pending' || paymentStatus === 'declined' ? null : 'MOCK-confirmed' };
  if (paymentStatus === 'confirmed' || paymentStatus === 'refunded') payment.providerReference = 'MOCK-' + payment.id;
  payment.hash = await financialIntegrity.digest(paymentContent(payment));
  let settled = 0, rejected = 0;
  // Deliberately narrow unit fixture: SQL persistence and rollback are exercised by financial-smoke.mts.
  const tx = { async policy() { return policy; }, async payment() { return payment; }, async signature() { return null; },
    async command() { return null; }, async createCommand() {} } as unknown as FinancialTransaction;
  const finance = new PolicyFinance({ enabled: true, environment: 'local', integrity: financialIntegrity, now: financialNow, newId: randomUUID,
    store: { async transaction(work) { return work(tx); }, async rejection() { rejected++; } },
    payments: { async lookup() { return { ...known, reference: known.reference === 'MOCK-confirmed' ? payment.providerReference : known.reference }; }, async settle() { settled++; return { status: 'uncertain', reference: null }; }, async refund() { throw new Error('unexpected_refund'); } },
    signatures: { async sign() { throw new Error('unexpected_signature'); } } });
  return { finance, policy, actor: offer, counts: () => ({ settled, rejected }) };
}

test('incoherent policy and premium states are audited before a provider can be called', async () => {
  for (const [policy, payment] of [['pending', 'confirmed'], ['charged', 'pending'], ['refunding', 'declined'], ['refunded', 'confirmed']] as const) {
    const fixture = await stateFixture(policy, payment, { status: 'unknown', reference: null });
    const result = await fixture.finance.get({ actor: fixture.actor, policyId: fixture.policy.id, traceId: randomUUID() });
    assert.ok(result.status === 'denied' && result.error === 'integrity_violation');
    assert.deepEqual(fixture.counts(), { settled: 0, rejected: 1 });
  }
});

test('a claimed confirmation cannot create a new charge or replace its provider reference', async () => {
  for (const known of [{ status: 'unknown' as const, reference: null }, { status: 'confirmed' as const, reference: 'altered-reference' },
    { status: 'refunded' as const, reference: 'MOCK-confirmed' }]) {
    const fixture = await stateFixture('charged', 'confirmed', known);
    const result = await fixture.finance.issue({ actor: fixture.actor, policyId: fixture.policy.id, documentHash: fixture.policy.documentHash,
      idempotencyKey: randomUUID(), traceId: randomUUID() });
    assert.ok(result.status === 'denied' && result.error === 'integrity_violation');
    assert.deepEqual(fixture.counts(), { settled: 0, rejected: 1 });
  }
});
