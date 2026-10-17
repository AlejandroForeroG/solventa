import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import type { FinancialDecisionCapture } from '../backend/policy-claims-payments/src/application/financial-decision';
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
  return { finance, policy, payment, actor: offer, counts: () => ({ settled, rejected }) };
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

test('signature refusal and expiry while acquiring the final lock refund the fresh confirmed payment without issuing', async () => {
  for (const scenario of ['signature_refused', 'expired_after_final_lock'] as const) {
    const fixture = await stateFixture('pending', 'pending', { status: 'unknown', reference: null });
    const { policy, payment } = fixture;
    let clock = financialNow(), transactions = 0, refunds = 0, signatures = 0;
    let externalStatus: 'unknown' | 'confirmed' | 'refunded' = 'unknown';
    const actions: string[] = [];
    const captures: FinancialDecisionCapture[] = [];
    const tx = { async policy() {
      if (scenario === 'expired_after_final_lock' && transactions === 3) clock = new Date(policy.offer.expiresAt);
      return { ...policy };
    }, async payment() { return { ...payment }; }, async signature() { return null; }, async command() { return null; }, async createCommand() {},
    async setPolicyStatus(_id: string, status: StoredPolicy['status']) { policy.status = status; },
    async setPaymentStatus(_id: string, status: Payment['status'], reference: string | null) { payment.status = status; payment.providerReference = reference; },
    async audit(action: string, _id: string, _trace: string, _outcome: string, _actor: string, capture: FinancialDecisionCapture) {
      actions.push(action); captures.push(capture);
    }, async recordSignature() { signatures++; }, async finishCommand() {} } as unknown as FinancialTransaction;
    const finance = new PolicyFinance({ enabled: true, environment: 'local', integrity: financialIntegrity, now: () => clock, newId: randomUUID,
      store: { async transaction(work) { transactions++; return work(tx); }, async rejection(_id, _trace, code) { actions.push(code); } },
      payments: { async lookup() { return { status: externalStatus, reference: externalStatus === 'unknown' ? null : 'MOCK-' + payment.id }; },
        async settle() { externalStatus = 'confirmed'; return { status: 'confirmed', reference: 'MOCK-' + payment.id }; },
        async refund(input) { assert.equal(input.status, 'confirmed'); assert.equal(input.providerReference, 'MOCK-' + payment.id);
          refunds++; externalStatus = 'refunded'; return { status: 'refunded', reference: 'MOCK-' + payment.id }; } },
      signatures: { async sign(id, hash) { return scenario === 'signature_refused' ? { status: 'failed' } : {
        status: 'signed', receipt: await financialIntegrity.digest(JSON.stringify(['mock-signature-v1', id, hash])) }; } } });
    const result = await finance.issue({ actor: fixture.actor, policyId: policy.id, documentHash: policy.documentHash, idempotencyKey: randomUUID(), traceId: randomUUID() });
    assert.ok(result.status === 'denied' && result.error === 'signature_failed', JSON.stringify(result));
    assert.equal(policy.status, 'refunded'); assert.equal(payment.status, 'refunded');
    assert.equal(refunds, 1); assert.equal(signatures, 0); assert.equal(actions.includes('policy.issued'), false);
    assert.deepEqual(actions, ['premium.confirmed', 'premium.refund_requested', 'premium.refunded', 'signature_failed']);
    const validate = new Ajv({ allErrors: true }).compile(JSON.parse(readFileSync('packages/contracts/schemas/decision-capture.v1.json', 'utf8')));
    for (const capture of captures) {
      assert.equal(validate(capture), true, JSON.stringify(validate.errors));
      assert.equal(capture.inputs.documentHash, policy.documentHash);
      assert.equal(capture.inputs.termsHash, policy.termsHash);
      assert.deepEqual(capture.inputs.offer, { acceptanceId: policy.offer.acceptanceId, offerId: policy.offerId, offerVersion: policy.offerVersion,
        product: policy.offer.product, premium: policy.offer.premium, currency: 'COP', coverage: policy.offer.coverage,
        effectiveFrom: policy.effectiveFrom, effectiveUntil: policy.effectiveUntil, expiresAt: policy.offer.expiresAt,
        acceptedAt: policy.offer.acceptedAt, ruleVersion: policy.offer.ruleVersion });
      assert.deepEqual(capture.inputs.payment, { paymentId: payment.id, operation: 'premium', amount: policy.premium,
        currency: 'COP', intentKey: 'initial-premium', intentHash: payment.hash,
        status: capture.rule.id === 'premium.refunded' ? 'refunded' : 'confirmed', providerReference: 'MOCK-' + payment.id });
      assert.equal(JSON.stringify(capture).includes(policy.clientId), false);
      assert.equal(JSON.stringify(capture).includes(policy.subjectToken), false);
    }
    assert.deepEqual(captures[0].sources.map(source => [source.operation, source.result]), [['lookup', 'unknown'], ['settle', 'confirmed']]);
    assert.equal(captures[1].inputs.refundReason, scenario === 'signature_refused' ? 'signature_refused' : 'expired_during_final_transaction');
    assert.deepEqual(captures[1].sources.map(source => [source.operation, source.result]), [['sign', scenario === 'signature_refused' ? 'failed' : 'signed']]);
    assert.deepEqual(captures[2].sources.map(source => [source.operation, source.result, source.reference]),
      [['lookup', 'confirmed', 'MOCK-' + payment.id], ['refund', 'refunded', 'MOCK-' + payment.id]]);
    const captured = JSON.stringify(captures);
    policy.offer.premium = '1.0000';
    if (policy.offer.coverage.kind === 'mortgage_life') policy.offer.coverage.sumInsured = '1.0000';
    payment.amount = '1.0000';
    assert.equal(JSON.stringify(captures), captured, 'later projection or fixture mutation cannot rewrite decision evidence');
  }
});

test('a persisted issuance timestamp at the offer deadline is rejected even with a valid keyed seal', async () => {
  const fixture = await stateFixture('issued', 'confirmed', { status: 'unknown', reference: null });
  const { policy, payment } = fixture, signedAt = policy.offer.expiresAt;
  let rejected = 0;
  const tx = { async policy() { return policy; }, async payment() { return payment; }, async signature() { return {
    documentHash: policy.documentHash, signedAt, receipt: await financialIntegrity.digest(JSON.stringify(['mock-signature-v1', policy.id, policy.documentHash])),
    timeSeal: await financialIntegrity.digest(issuanceTimeContent(policy.id, policy.documentHash, signedAt)) }; } } as unknown as FinancialTransaction;
  const never = async (): Promise<never> => { throw new Error('unexpected_provider_call'); };
  const finance = new PolicyFinance({ enabled: true, environment: 'local', integrity: financialIntegrity, now: financialNow, newId: randomUUID,
    store: { async transaction(work) { return work(tx); }, async rejection() { rejected++; } }, payments: { lookup: never, settle: never, refund: never }, signatures: { sign: never } });
  const result = await finance.get({ actor: fixture.actor, policyId: policy.id, traceId: randomUUID() });
  assert.ok(result.status === 'denied' && result.error === 'integrity_violation'); assert.equal(rejected, 1);
});
