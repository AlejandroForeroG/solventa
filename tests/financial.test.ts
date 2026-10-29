import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import type { FinancialDecisionCapture } from '../backend/policy-claims-payments/src/application/financial-decision';
import type { FinancialActor, PolicyView } from '../backend/policy-claims-payments/src/domain/financial';
import { eventContent, eventWithinIssuedCoverage, isOfferEnvelope, isParametricEnvelope, issuanceTimeContent, money, offerContent, paymentContent, policyDocument } from '../backend/policy-claims-payments/src/domain/financial';
import type { AcceptanceSnapshot, AcceptedPolicyLookup, FinancialStore, FinancialTransaction, ImportedEvent, IssuanceCommit, Payment, PaymentGateway, StoredPolicy } from '../backend/policy-claims-payments/src/application/ports/financial';
import { PolicyFinance } from '../backend/policy-claims-payments/src/application/policy-finance';
import { acceptedOffer, financialIntegrity, financialNow, flightEvent } from './financial-fixtures';
import { createPolicyFinance } from '../backend/policy-claims-payments/src/adapters/composition';

const unusedStoreReads: Pick<FinancialStore, 'readPolicy' | 'readAcceptedPolicy' | 'importAcceptance' | 'issuanceCandidates'> = {
  async readPolicy() { throw new Error('unexpected_policy_read'); },
  async issuanceCandidates() { throw new Error('unexpected_recovery_scan'); },
  async readAcceptedPolicy() { throw new Error('unexpected_acceptance_read'); },
  async importAcceptance() { throw new Error('unexpected_import'); }
};
const readStore = (tx: Pick<FinancialTransaction, 'policy'>) => ({
  ...unusedStoreReads,
  readPolicy: (id: string, actor: Parameters<FinancialStore['readPolicy']>[1]) => tx.policy(id, actor),
  readAcceptedPolicy: unusedStoreReads.readAcceptedPolicy
});

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
    store: { ...unusedStoreReads, async transaction<T>(): Promise<T> { throw new Error('not_expected'); }, async rejection() { calls++; throw new Error('sql_unavailable'); } },
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
  const tx = { async policy() { return { policy, premium: payment, signature: null }; },
    async issuanceSnapshot(id: string, actor: Parameters<FinancialTransaction['issuanceSnapshot']>[1], key: string) { assert.match(key, /^[a-f0-9]{64}$/); return { record: await tx.policy(id, actor), command: null }; },
    async createCommand() {} } as unknown as FinancialTransaction;
  const finance = new PolicyFinance({ enabled: true, environment: 'local', integrity: financialIntegrity, now: financialNow, newId: randomUUID,
    store: { ...readStore(tx), async transaction(work) { return work(tx); }, async rejection() { rejected++; } },
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
      return { policy: { ...policy }, premium: { ...payment }, signature: null };
    }, async issuanceSnapshot(id: string, actor: Parameters<FinancialTransaction['issuanceSnapshot']>[1], key: string) { assert.match(key, /^[a-f0-9]{64}$/); return { record: await tx.policy(id, actor), command: null }; },
    async createCommand() {},
    async setPolicyStatus(_id: string, status: StoredPolicy['status']) { policy.status = status; },
    async setPaymentStatus(_id: string, status: Payment['status'], reference: string | null) { payment.status = status; payment.providerReference = reference; },
    async audit(action: string, _id: string, _trace: string, _outcome: string, _actor: string, capture: FinancialDecisionCapture) {
      actions.push(action); captures.push(capture);
    }, async confirmPremium(_policy: StoredPolicy, confirmed: Payment, _trace: string, capture: FinancialDecisionCapture) {
      payment.status = 'confirmed'; payment.providerReference = confirmed.providerReference; policy.status = 'charged';
      actions.push('premium.confirmed'); captures.push(capture);
    }, async completeIssuance() { signatures++; }, async finishCommand() {} } as unknown as FinancialTransaction;
    const finance = new PolicyFinance({ enabled: true, environment: 'local', integrity: financialIntegrity, now: () => clock, newId: randomUUID,
      store: { ...readStore(tx), async transaction(work) { transactions++; return work(tx); }, async rejection(_id, _trace, code) { actions.push(code); } },
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

test('issuance requires the exact stored signature evidence before committing its issued audit or completion', async () => {
  for (const mode of ['stored', 'missing', 'wrong_document', 'wrong_receipt', 'wrong_timestamp', 'wrong_seal']) {
    const { policy, payment, actor } = await stateFixture('charged', 'confirmed', { status: 'confirmed', reference: 'MOCK-confirmed' });
    const actions: string[] = [];
    let completed = 0;
    const tx = {
      async policy() { return { policy: { ...policy }, premium: { ...payment }, signature: null }; },
      async issuanceSnapshot(id: string, actor: Parameters<FinancialTransaction['issuanceSnapshot']>[1], key: string) { assert.match(key, /^[a-f0-9]{64}$/); return { record: await tx.policy(id, actor), command: null }; },
    async createCommand() {},
      async setPolicyStatus(_id: string, status: StoredPolicy['status']) { policy.status = status; },
      async audit(action: string) { actions.push(action); },
      async finishCommand() { completed++; },
      async completeIssuance(input: IssuanceCommit) {
        const { documentHash, receipt, signedAt, timeSeal } = input.signature;
        if (mode === 'missing') throw new Error('signature_insert_incomplete');
        policy.status = 'issued'; actions.push('policy.issued'); completed++;
        return { documentHash: mode === 'wrong_document' ? '0'.repeat(64) : documentHash,
          receipt: mode === 'wrong_receipt' ? '0'.repeat(64) : receipt,
          signedAt: mode === 'wrong_timestamp' ? '2026-10-16T00:00:00.000Z' : signedAt,
          timeSeal: mode === 'wrong_seal' ? '0'.repeat(64) : timeSeal };
      },
    } as unknown as FinancialTransaction;
    const never = async (): Promise<never> => { throw new Error('unexpected_new_payment'); };
    const finance = new PolicyFinance({ enabled: true, environment: 'local', integrity: financialIntegrity, now: financialNow, newId: randomUUID,
      store: { ...readStore(tx), async transaction(work) {
        const before = { status: policy.status, actions: actions.length, completed };
        try { return await work(tx); }
        catch (error) { policy.status = before.status; actions.length = before.actions; completed = before.completed; throw error; }
      }, async rejection() { actions.push('denied'); } },
      payments: { async lookup() { return { status: 'confirmed', reference: payment.providerReference }; }, settle: never, refund: never },
      signatures: { async sign(id, hash) { return { status: 'signed', receipt: await financialIntegrity.digest(JSON.stringify(['mock-signature-v1', id, hash])) }; } } });
    const result = await finance.issue({ actor, policyId: policy.id, documentHash: policy.documentHash, idempotencyKey: randomUUID(), traceId: randomUUID() });
    assert.equal(result.status, mode === 'stored' ? 'ok' : 'unavailable', JSON.stringify({ mode, result }));
    assert.equal(policy.status, mode === 'stored' ? 'issued' : 'charged');
    assert.deepEqual(actions, mode === 'stored' ? ['policy.issued'] : []);
    assert.equal(completed, mode === 'stored' ? 1 : 0);
  }
});

test('a persisted issuance timestamp at the offer deadline is rejected even with a valid keyed seal', async () => {
  const fixture = await stateFixture('issued', 'confirmed', { status: 'unknown', reference: null });
  const { policy, payment } = fixture, signedAt = policy.offer.expiresAt;
  let rejected = 0;
  const tx = { async policy() { return { policy, premium: payment, signature: {
    documentHash: policy.documentHash, signedAt, receipt: await financialIntegrity.digest(JSON.stringify(['mock-signature-v1', policy.id, policy.documentHash])),
    timeSeal: await financialIntegrity.digest(issuanceTimeContent(policy.id, policy.documentHash, signedAt)) } }; } } as unknown as FinancialTransaction;
  const never = async (): Promise<never> => { throw new Error('unexpected_provider_call'); };
  const finance = new PolicyFinance({ enabled: true, environment: 'local', integrity: financialIntegrity, now: financialNow, newId: randomUUID,
    store: { ...readStore(tx), async transaction(work) { return work(tx); }, async rejection() { rejected++; } }, payments: { lookup: never, settle: never, refund: never }, signatures: { sign: never } });
  const result = await finance.get({ actor: fixture.actor, policyId: policy.id, traceId: randomUUID() });
  assert.ok(result.status === 'denied' && result.error === 'integrity_violation'); assert.equal(rejected, 1);
});

test('an unimported acceptance is an unaudited pending result, while an existing foreign one is an audited not_found', async () => {
  const { policy, payment } = await stateFixture('pending', 'pending', { status: 'unknown', reference: null });
  const owner = { clientId: policy.clientId, subjectToken: policy.subjectToken };
  const never = async (): Promise<never> => { throw new Error('unexpected_provider_call'); };
  const cases: [AcceptedPolicyLookup, FinancialActor, string | null][] = [
    [{ status: 'absent' }, owner, null],
    [{ status: 'foreign' }, { clientId: randomUUID(), subjectToken: randomUUID() }, 'not_found'],
    [{ status: 'foreign' }, { clientId: owner.clientId, subjectToken: randomUUID() }, 'not_found'],
    [{ status: 'owned', record: { policy, premium: payment, signature: null } }, { clientId: randomUUID(), subjectToken: owner.subjectToken }, 'not_found'],
    [{ status: 'owned', record: { policy, premium: payment, signature: null } }, owner, 'ok']];
  for (const [lookup, actor, expected] of cases) {
    const rejections: string[] = [];
    const finance = new PolicyFinance({ enabled: true, environment: 'local', integrity: financialIntegrity, now: financialNow, newId: randomUUID,
      store: { ...unusedStoreReads, async readAcceptedPolicy(acceptanceId, read) { assert.equal(acceptanceId, policy.offer.acceptanceId); assert.deepEqual(read, actor); return lookup; },
        async transaction() { throw new Error('unexpected_transaction'); }, async rejection(_id, _trace, cause) { rejections.push(cause); } },
      payments: { lookup: never, settle: never, refund: never }, signatures: { sign: never } });
    const traceId = randomUUID();
    const result = await finance.getByAcceptance({ actor, acceptanceId: policy.offer.acceptanceId, traceId });
    if (expected === 'ok') { assert.ok(result.status === 'ok' && result.policy.policyId === policy.id); assert.deepEqual(rejections, []); }
    else if (expected === null) { assert.deepEqual(result, { status: 'denied', error: 'policy_pending', httpStatus: 404, traceId }); assert.deepEqual(rejections, []); }
    else { assert.deepEqual(result, { status: 'denied', error: expected, httpStatus: 404, traceId }); assert.deepEqual(rejections, [expected]); }
  }
});

async function importFixture(snapshot: (event: Awaited<ReturnType<typeof acceptedOffer>>) => Promise<AcceptanceSnapshot>,
  stored?: (event: Awaited<ReturnType<typeof acceptedOffer>>, policyId: string) => Promise<StoredPolicy>, failWrite = false) {
  const event = await acceptedOffer();
  const imports: { policy: StoredPolicy; event: ImportedEvent; capture: FinancialDecisionCapture }[] = [];
  const rejections: string[] = [];
  const tx = {
    async policy(id: string) {
      return stored ? { policy: await stored(event, id), premium: null, signature: null } : null;
    },
  } as unknown as FinancialTransaction;
  const never = async (): Promise<never> => { throw new Error('unexpected_provider_call'); };
  const finance = new PolicyFinance({ enabled: true, environment: 'local', integrity: financialIntegrity, now: financialNow, newId: randomUUID,
    store: { ...readStore(tx), async transaction(work) { return work(tx); },
      async importAcceptance(policy, imported, _trace, capture) {
        assert.deepEqual([imported.eventId, imported.consumer, policy.offer.acceptanceId, policy.offerId, policy.offerVersion],
          [event.eventId, 'policy.offer-accepted.v1', event.payload.acceptanceId, event.payload.offerId, event.payload.offerVersion]);
        const existing = await snapshot(event);
        if (existing.inbox || existing.conflict) return { status: 'existing', snapshot: existing };
        if (failWrite) throw new Error('sql_unavailable');
        imports.push({ policy, event: imported, capture }); return { status: 'created' };
      }, async rejection(_id, _trace, code) { rejections.push(code); } },
    payments: { lookup: never, settle: never, refund: never }, signatures: { sign: never } });
  return { event, imports, rejections, result: await finance.acceptOffer(event, randomUUID()) };
}

async function storedFrom(event: Awaited<ReturnType<typeof acceptedOffer>>, id: string): Promise<StoredPolicy> {
  const offer = event.payload, document = policyDocument(id, offer);
  return { id, clientId: offer.clientId, subjectToken: offer.subjectToken, status: 'pending', offer,
    termsHash: await financialIntegrity.digest(offerContent(offer)), document, documentHash: await financialIntegrity.digest(document),
    premium: offer.premium, currency: 'COP', offerId: offer.offerId, offerVersion: offer.offerVersion,
    effectiveFrom: offer.effectiveFrom, effectiveUntil: offer.effectiveUntil, coverageSnapshot: offer.coverage };
}

test('a new accepted offer imports its authenticated event, policy and decision capture', async () => {
  const fixture = await importFixture(async () => ({ inbox: null, conflict: false }));
  assert.equal(fixture.result.status, 'ok', JSON.stringify(fixture.result));
  assert.ok(fixture.result.status === 'ok' && !fixture.result.replayed && fixture.result.policy.status === 'pending');
  const [imported] = fixture.imports;
  assert.deepEqual(imported.event, { eventId: fixture.event.eventId, consumer: 'policy.offer-accepted.v1', eventType: 'offer.accepted',
    hash: await financialIntegrity.digest(eventContent(fixture.event)) });
  assert.equal(imported.capture.rule.id, 'offer.accepted');
  assert.equal(imported.capture.inputs.resourceId, imported.policy.id);
  assert.deepEqual(fixture.rejections, []);
});

test('an existing acceptance, offer revision or reused event identifier is an audited conflict without a write', async () => {
  const hashOf = async (event: Awaited<ReturnType<typeof acceptedOffer>>) => financialIntegrity.digest(eventContent(event));
  for (const snapshot of [
    async () => ({ inbox: null, conflict: true }),
    async () => ({ inbox: { hash: '0'.repeat(64), policyId: randomUUID(), outcome: 'accepted' }, conflict: true }),
    async () => ({ inbox: { hash: null, policyId: randomUUID(), outcome: 'accepted' }, conflict: false }),
    async (event: Awaited<ReturnType<typeof acceptedOffer>>) => ({ inbox: { hash: await hashOf(event), policyId: null, outcome: 'accepted' }, conflict: true })]) {
    const fixture = await importFixture(snapshot, storedFrom);
    assert.ok(fixture.result.status === 'denied' && fixture.result.error === 'event_conflict', JSON.stringify(fixture.result));
    assert.equal(fixture.imports.length, 0);
    assert.deepEqual(fixture.rejections, ['event_conflict']);
  }
});

test('an identical redelivery replays only after the stored policy passes the full integrity check', async () => {
  const replay = async (event: Awaited<ReturnType<typeof acceptedOffer>>) => ({
    inbox: { hash: await financialIntegrity.digest(eventContent(event)), policyId: randomUUID(), outcome: 'accepted' }, conflict: true });
  const fixture = await importFixture(replay, storedFrom);
  assert.ok(fixture.result.status === 'ok' && fixture.result.replayed, JSON.stringify(fixture.result));
  assert.equal(fixture.imports.length, 0);
  for (const tamper of [(policy: StoredPolicy) => { policy.premium = '1.0000'; }, (policy: StoredPolicy) => { policy.document += ' '; },
    (policy: StoredPolicy) => { policy.status = 'issued'; }]) {
    const tampered = await importFixture(replay, async (event, id) => { const policy = await storedFrom(event, id); tamper(policy); return policy; });
    assert.ok(tampered.result.status === 'denied' && tampered.result.error === 'integrity_violation', JSON.stringify(tampered.result));
    assert.deepEqual(tampered.rejections, ['integrity_violation']);
  }
});

test('a failed atomic import write is a technical failure, not a durable result or a business rejection', async () => {
  const fixture = await importFixture(async () => ({ inbox: null, conflict: false }), undefined, true);
  assert.equal(fixture.result.status, 'unavailable');
  assert.deepEqual(fixture.rejections, []);
});


test('a failed initial premium bundle never reaches a provider or creates an apparent successful issuance', async () => {
  const event = await acceptedOffer(), policy = await storedFrom(event, randomUUID());
  let attempted = false, providers = 0;
  const tx = { async issuanceSnapshot() { return { record: { policy, premium: null, signature: null }, command: null }; },
    async beginPremium(input: Parameters<FinancialTransaction['beginPremium']>[0]) {
      attempted = true;
      assert.equal(input.policy.id, policy.id);
      assert.equal(input.payment.policyId, policy.id);
      assert.equal(input.payment.status, 'pending');
      assert.ok(input.command);
      assert.equal(input.capture.rule.id, 'premium.requested');
      throw new Error('required_outbox_unavailable');
    } } as unknown as FinancialTransaction;
  const never = async (): Promise<never> => { providers++; throw new Error('unexpected_provider_call'); };
  const finance = new PolicyFinance({ enabled: true, environment: 'local', integrity: financialIntegrity, now: financialNow, newId: randomUUID,
    store: { ...unusedStoreReads, async transaction(work) { return work(tx); }, async rejection() { throw new Error('unexpected_business_denial'); } },
    payments: { lookup: never, settle: never, refund: never }, signatures: { sign: never } });
  const result = await finance.issue({ actor: event.payload, policyId: policy.id, documentHash: policy.documentHash,
    idempotencyKey: randomUUID(), traceId: randomUUID() });
  assert.equal(result.status, 'unavailable');
  assert.equal(attempted, true);
  assert.equal(providers, 0);
});

async function recoveryFixture(options: { policyStatus: StoredPolicy['status']; paymentStatus: Payment['status']; provider: 'unknown' | 'confirmed';
  clock?: Date; commandDocumentHash?: string; enabled?: boolean; onSign?: (policy: StoredPolicy) => void }) {
  const { policy, payment } = await stateFixture(options.policyStatus, options.paymentStatus, { status: 'unknown', reference: null });
  const commandKey = await financialIntegrity.digest(randomUUID());
  const requestHash = await financialIntegrity.digest(JSON.stringify(['issue.v1', policy.clientId, policy.id, options.commandDocumentHash ?? policy.documentHash]));
  let provider: 'unknown' | 'confirmed' | 'refunded' = options.provider;
  const calls = { settle: 0, refund: 0, sign: 0 }, actions: string[] = [], captures: FinancialDecisionCapture[] = [];
  let completedKey: string | null = null;
  const tx = {
    async policy() { return { policy: { ...policy }, premium: { ...payment }, signature: null }; },
    async issuanceSnapshot(_id: string, _actor: FinancialActor, key: string) {
      assert.equal(key, commandKey);
      return { record: await tx.policy(policy.id), command: { policyId: policy.id, requestHash, result: null } };
    },
    async setPolicyStatus(_id: string, status: StoredPolicy['status']) { policy.status = status; },
    async setPaymentStatus(_id: string, status: Payment['status'], reference: string | null) { payment.status = status; payment.providerReference = reference; },
    async audit(action: string, _id: string, _trace: string, _outcome: string, _actor: string, capture: FinancialDecisionCapture) { actions.push(action); captures.push(capture); },
    async confirmPremium(_policy: StoredPolicy, confirmed: Payment, _trace: string, capture: FinancialDecisionCapture) {
      payment.status = 'confirmed'; payment.providerReference = confirmed.providerReference; policy.status = 'charged';
      actions.push('premium.confirmed'); captures.push(capture);
    },
    async completeIssuance(input: IssuanceCommit) {
      policy.status = 'issued'; completedKey = input.commandKey; actions.push('policy.issued'); captures.push(input.capture);
      return input.signature;
    },
    async finishCommand(_actor: string, key: string) { completedKey = key; }
  } as unknown as FinancialTransaction;
  let candidatesRead = 0;
  const store: FinancialStore = { ...readStore(tx), async transaction(work) { return work(tx); }, async rejection(_id, _trace, code) { actions.push(code); },
    async issuanceCandidates() { candidatesRead++; return [{ policyId: policy.id, actor: { clientId: policy.clientId, subjectToken: policy.subjectToken }, commandKey }]; } };
  const finance = new PolicyFinance({ enabled: options.enabled ?? true, environment: 'local', integrity: financialIntegrity, now: () => options.clock ?? financialNow(), newId: randomUUID,
    store,
    payments: {
      async lookup() { return { status: provider, reference: provider === 'unknown' ? null : 'MOCK-' + payment.id }; },
      async settle() { calls.settle++; throw new Error('recovery_must_not_start_a_charge'); },
      async refund() { calls.refund++; provider = 'refunded'; return { status: 'refunded', reference: 'MOCK-' + payment.id }; } },
    signatures: { async sign(id, hash) { calls.sign++; options.onSign?.(policy); return { status: 'signed', receipt: await financialIntegrity.digest(JSON.stringify(['mock-signature-v1', id, hash])) }; } } });
  return { finance, store, policy, payment, calls, actions, captures, commandKey, completed: () => completedKey, candidatesRead: () => candidatesRead };
}

test('recovery issues a confirmed charge whose customer command stopped, without a new charge or a client retry', async () => {
  for (const [policyStatus, paymentStatus] of [['charged', 'confirmed'], ['pending', 'pending']] as const) {
    const fixture = await recoveryFixture({ policyStatus, paymentStatus, provider: 'confirmed' });
    const [result] = await fixture.finance.reconcileIssuances(new Date(), 25);
    assert.equal(result.outcome, 'issued', policyStatus);
    assert.equal(fixture.policy.status, 'issued');
    assert.deepEqual(fixture.calls, { settle: 0, refund: 0, sign: 1 });
    assert.equal(fixture.completed(), fixture.commandKey, 'the original customer command receives the result');
    assert.deepEqual(fixture.actions, policyStatus === 'pending' ? ['premium.confirmed', 'policy.issued'] : ['policy.issued']);
    for (const capture of fixture.captures) {
      assert.equal(capture.inputs.trigger, 'reconciliation');
      assert.equal(capture.rule.version, 'academic-financial-1');
      assert.equal(capture.correlationId, result.traceId);
    }
  }
});

test('recovery refunds a confirmed charge once the signing window has expired', async () => {
  const fixture = await recoveryFixture({ policyStatus: 'charged', paymentStatus: 'confirmed', provider: 'confirmed', clock: new Date('2026-10-16T02:15:00.000Z') });
  const [result] = await fixture.finance.reconcileIssuances(new Date(), 25);
  assert.equal(result.outcome, 'refunded');
  assert.equal(fixture.policy.status, 'refunded'); assert.equal(fixture.payment.status, 'refunded');
  assert.deepEqual(fixture.calls, { settle: 0, refund: 1, sign: 0 });
  assert.deepEqual(fixture.actions, ['premium.refund_requested', 'premium.refunded', 'signature_failed']);
  assert.equal(fixture.captures[0].inputs.refundReason, 'expired_before_sign');
  assert.ok(fixture.captures.every(capture => capture.inputs.trigger === 'reconciliation'));
});

test('recovery leaves a pending intent without a provider charge untouched and never starts one', async () => {
  const fixture = await recoveryFixture({ policyStatus: 'pending', paymentStatus: 'pending', provider: 'unknown' });
  const [result] = await fixture.finance.reconcileIssuances(new Date(), 25);
  assert.equal(result.outcome, 'unchanged');
  assert.equal(fixture.policy.status, 'pending');
  assert.deepEqual(fixture.calls, { settle: 0, refund: 0, sign: 0 });
  assert.deepEqual(fixture.actions, []);
});

test('recovery does not report a completed refund while another request is still refunding', async () => {
  const fixture = await recoveryFixture({ policyStatus: 'charged', paymentStatus: 'confirmed', provider: 'confirmed',
    onSign: policy => { policy.status = 'refunding'; } });
  const [result] = await fixture.finance.reconcileIssuances(new Date(), 25);
  assert.equal(fixture.policy.status, 'refunding');
  assert.equal(result.outcome, 'unchanged');
  assert.equal(fixture.calls.refund, 0);
  assert.equal(fixture.actions.includes('premium.refunded'), false);
});

test('recovery reports unavailable when the authoritative refund state cannot be read', async () => {
  const fixture = await recoveryFixture({ policyStatus: 'charged', paymentStatus: 'confirmed', provider: 'confirmed',
    onSign: policy => { policy.status = 'refunding'; } });
  fixture.store.readPolicy = async () => { throw new Error('policy_read_unavailable'); };
  const [result] = await fixture.finance.reconcileIssuances(new Date(), 25);
  assert.equal(result.outcome, 'unavailable');
  assert.equal(fixture.policy.status, 'refunding');
});

test('recovery refuses a stored command that does not authorize the current document', async () => {
  const fixture = await recoveryFixture({ policyStatus: 'charged', paymentStatus: 'confirmed', provider: 'confirmed', commandDocumentHash: '0'.repeat(64) });
  const [result] = await fixture.finance.reconcileIssuances(new Date(), 25);
  assert.deepEqual({ outcome: result.outcome, error: result.error }, { outcome: 'rejected', error: 'integrity_violation' });
  assert.equal(fixture.policy.status, 'charged');
  assert.deepEqual(fixture.calls, { settle: 0, refund: 0, sign: 0 });
  assert.deepEqual(fixture.actions, ['integrity_violation']);
});

test('disabled financial configuration does not look for recovery candidates', async () => {
  const fixture = await recoveryFixture({ policyStatus: 'charged', paymentStatus: 'confirmed', provider: 'confirmed', enabled: false });
  assert.deepEqual(await fixture.finance.reconcileIssuances(new Date(), 25), []);
  assert.equal(fixture.candidatesRead(), 0);
});

test('policy reads expose the premium state and only an acknowledged synthetic receipt', async () => {
  for (const [policyStatus, paymentStatus, reference] of [['pending', 'pending', false], ['pending', 'declined', false],
    ['charged', 'confirmed', true], ['refunded', 'refunded', true]] as const) {
    const fixture = await stateFixture(policyStatus, paymentStatus, { status: 'unknown', reference: null });
    const result = await fixture.finance.get({ actor: fixture.actor, policyId: fixture.policy.id, traceId: randomUUID() });
    assert.ok(result.status === 'ok', JSON.stringify(result));
    assert.deepEqual(result.payment, { status: paymentStatus, reference: reference ? 'MOCK-' + fixture.payment.id : null });
    assert.equal('payment' in result.policy, false, 'the stored command result shape stays unchanged for replays');
  }
});

async function issuedConcurrently(moment: 'before_confirmation' | 'before_refund') {
  const { policy, payment, actor } = await stateFixture(moment === 'before_refund' ? 'charged' : 'pending', moment === 'before_refund' ? 'confirmed' : 'pending', { status: 'unknown', reference: null });
  const confirmed: Payment = { ...payment, status: 'confirmed', providerReference: 'MOCK-' + payment.id };
  const signedAt = '2026-10-16T02:01:00.000Z';
  const signature = { documentHash: policy.documentHash, signedAt,
    receipt: await financialIntegrity.digest(JSON.stringify(['mock-signature-v1', policy.id, policy.documentHash])),
    timeSeal: await financialIntegrity.digest(issuanceTimeContent(policy.id, policy.documentHash, signedAt)) };
  const issuedFrom = moment === 'before_confirmation' ? 2 : 3;
  let transactions = 0;
  const commands: { actorId: string; key: string; policyId: string; requestHash: string; result: PolicyView | null }[] = [];
  const calls = { settle: 0, refund: 0, sign: 0 }, actions: string[] = [];
  const tx = {
    async policy() {
      return transactions >= issuedFrom ? { policy: { ...policy, status: 'issued' as const }, premium: { ...confirmed }, signature: { ...signature } }
        : { policy: { ...policy }, premium: { ...payment }, signature: null };
    },
    async issuanceSnapshot() { return { record: await tx.policy(), command: null }; },
    async createCommand(actorId: string, key: string, policyId: string, requestHash: string) { commands.push({ actorId, key, policyId, requestHash, result: null }); },
    async finishCommand(actorId: string, key: string, result: PolicyView) {
      const command = commands.find(stored => stored.actorId === actorId && stored.key === key);
      if (command) command.result = result;
    },
    async setPolicyStatus() { actions.push('status'); },
    async audit(action: string) { actions.push(action); },
    async confirmPremium() { actions.push('premium.confirmed'); },
    async completeIssuance() { actions.push('policy.issued'); }
  } as unknown as FinancialTransaction;
  const finance = new PolicyFinance({ enabled: true, environment: 'local', integrity: financialIntegrity, now: financialNow, newId: randomUUID,
    store: { ...unusedStoreReads, async transaction(work) { transactions++; return work(tx); }, async rejection(_id, _trace, code) { actions.push(code); } },
    payments: { async lookup() { return { status: 'confirmed', reference: confirmed.providerReference }; },
      async settle() { calls.settle++; throw new Error('unexpected_new_charge'); },
      async refund() { calls.refund++; throw new Error('unexpected_refund'); } },
    signatures: { async sign() { calls.sign++; return { status: 'failed' }; } } });
  const idempotencyKey = randomUUID();
  const result = await finance.issue({ actor, policyId: policy.id, documentHash: policy.documentHash, idempotencyKey, traceId: randomUUID() });
  const ownCommand = { actorId: policy.clientId, key: await financialIntegrity.digest(JSON.stringify(['command-key.v1', policy.clientId, idempotencyKey])),
    policyId: policy.id, requestHash: await financialIntegrity.digest(JSON.stringify(['issue.v1', policy.clientId, policy.id, policy.documentHash])) };
  return { result, calls, actions, commands, ownCommand, receipt: confirmed.providerReference };
}

test('a policy issued by another request before this charge is confirmed is returned without signing or charging again', async () => {
  const { result, calls, actions, commands, ownCommand, receipt } = await issuedConcurrently('before_confirmation');
  assert.ok(result.status === 'ok' && result.policy.status === 'issued', JSON.stringify(result));
  assert.deepEqual(result.payment, { status: 'confirmed', reference: receipt });
  assert.deepEqual(calls, { settle: 0, refund: 0, sign: 0 });
  assert.deepEqual(actions, [], 'no confirmation, issuance or refund decision is recorded twice');
  assert.ok(result.status === 'ok');
  assert.deepEqual(commands, [{ ...ownCommand, result: result.policy }], 'this request creates and completes its own command with the existing issuance');
});

test('a signature refusal does not refund a charge that another request already issued', async () => {
  const { result, calls, actions, commands, ownCommand } = await issuedConcurrently('before_refund');
  assert.ok(result.status === 'ok' && result.policy.status === 'issued', JSON.stringify(result));
  assert.deepEqual(calls, { settle: 0, refund: 0, sign: 1 });
  assert.deepEqual(actions, [], 'no refund intent is recorded for an issued policy');
  assert.ok(result.status === 'ok');
  assert.deepEqual(commands, [{ ...ownCommand, result: result.policy }], 'this request creates and completes its own command with the existing issuance');
});
