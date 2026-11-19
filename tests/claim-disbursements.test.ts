import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { Hono } from 'hono';
import { ClaimDisbursements } from '../backend/policy-claims-payments/src/application/claim-disbursements';
import type { DisbursementCapture, DisbursementContext, DisbursementStore, DisbursementTransaction } from '../backend/policy-claims-payments/src/application/ports/claim-disbursement';
import type { Payment, PaymentGateway } from '../backend/policy-claims-payments/src/application/ports/financial';
import { HmacFinancialIntegrity } from '../backend/policy-claims-payments/src/adapters/outbound/financial-integrity';
import { mountClaims } from '../backend/policy-claims-payments/src/adapters/inbound/claims-http';
import { amountWithinCoverage, parseDisbursement } from '../backend/policy-claims-payments/src/domain/claim-disbursement';
import { issuanceTimeContent, offerContent, type AcceptedOffer } from '../backend/policy-claims-payments/src/domain/financial';
import { mountClaimReport } from '../backend/policy-claims-payments/src/adapters/inbound/claim-report-http';
import { parseClaimPaymentPage } from '../packages/contracts/src/claim-payments';
import claimsExamples from '../packages/contracts/examples/claims.json';
import { lifecycleContent, type LifecycleAction, type LifecycleChange } from '../backend/policy-claims-payments/src/domain/policy-lifecycle';

test('terminal disbursement notices remain valid case-file contract responses', async () => {
  const spec = parse(await readFile(new URL('../packages/contracts/openapi/v1/claims.yaml', import.meta.url), 'utf8'));
  const ajv = new Ajv({ strict: false }); addFormats(ajv);
  assert.ok(spec.components.schemas.ClaimCase);
  const validate = ajv.compile({ ...spec.components.schemas.ClaimCase, components: spec.components });
  for (const action of ['disbursement_confirmed', 'disbursement_declined']) {
    const body = { ...claimsExamples.caseFile, notices: [{ id: randomUUID(), action, at: '2026-11-19T15:00:00.000Z' }] };
    assert.ok(validate(body), JSON.stringify(validate.errors));
    assert.equal(validate({ ...body, notices: [{ ...body.notices[0], action: 'invalid_notice' }] }), false);
  }
});

async function fixture() {
  let now = new Date('2026-11-19T15:00:00.000Z');
  const integrity = new HmacFinancialIntegrity('a'.repeat(64));
  const actor = { clientId: randomUUID(), subjectToken: randomUUID(), traceId: randomUUID(), expiresAt: '2026-11-19T15:00:04.000Z' };
  const offer: AcceptedOffer = { acceptanceId: randomUUID(), offerId: randomUUID(), offerVersion: 1, clientId: randomUUID(), subjectToken: randomUUID(),
    product: 'vida_hipotecario', premium: '100.0000', currency: 'COP', coverage: { kind: 'mortgage_life', sumInsured: '100000.0000' },
    effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveUntil: '2027-01-01T00:00:00.000Z', expiresAt: '2026-01-01T01:00:00.000Z',
    acceptedAt: '2026-01-01T00:00:01.000Z', ruleVersion: 'academic-financial-1' };
  const policyId = randomUUID(), documentHash = 'd'.repeat(64), issuedAt = '2026-01-01T00:00:02.000Z';
  const context: DisbursementContext = { claimId: randomUUID(), decisionId: randomUUID(), policyId, state: 'approved', policyStatus: 'issued',
    ownerSubjectToken: offer.subjectToken, analystId: actor.clientId, occurredAt: '2026-11-01T00:00:00.000Z', issuedAt, documentHash,
    signatureReceipt: await integrity.digest(JSON.stringify(['mock-signature-v1', policyId, documentHash])),
    timeSeal: await integrity.digest(issuanceTimeContent(policyId, documentHash, issuedAt)), premiumStatus: 'confirmed', reservedAmount: '0.0000',
    offer, termsHash: await integrity.digest(offerContent(offer)), lifecycle: null, payment: null, indemnityId: null, indemnityAmount: null };
  let prepares = 0, effects = 0, commits = 0, failCommit = false, failAfterEffect = false, failLookup = false, permitted = true;
  const ledger = new Map<string, string>();
  let authorizationCapture: DisbursementCapture | undefined;
  const tx: DisbursementTransaction = {
    owned: async () => context.payment ? [{ ...context, claimNumber: 'SIN-2026-00001', updatedAt: now.toISOString() }] : [],
    authorized: async () => permitted ? context : null,
    pending: async id => context.payment?.id === id ? context : null,
    create: async (_c, payment, indemnityId, _actor, capture) => { prepares++; authorizationCapture = capture; context.payment = { ...payment }; context.indemnityId = indemnityId; context.indemnityAmount = payment.amount; },
    finish: async (_c, status, reference) => {
      if (failCommit) throw Error('commit unavailable');
      assert.ok(context.payment); commits++; context.payment = { ...context.payment, status, providerReference: reference };
      if (status === 'confirmed') context.state = 'paid';
    }
  };
  const store: DisbursementStore = { transaction: async work => work(tx), candidates: async () => context.payment?.status === 'pending' ? [context.payment.id] : [] };
  const gateway: PaymentGateway = {
    lookup: async payment => {
      if (failLookup) throw Error('provider unavailable');
      return ledger.has(payment.id) ? { status: 'confirmed', reference: ledger.get(payment.id)! } : { status: 'unknown', reference: null };
    },
    settle: async payment => {
      const reference = 'MOCK-' + payment.id;
      if (!ledger.has(payment.id)) { ledger.set(payment.id, reference); effects++; }
      if (failAfterEffect) throw Error('response lost');
      return { status: 'confirmed', reference };
    }, refund: async () => { throw Error('must not refund an indemnity'); }
  };
  const service = new ClaimDisbursements(store, gateway, integrity, { race: async work => work }, { now: () => now, newId: randomUUID }, true);
  return { service, context, actor, store, gateway, integrity, capture: () => authorizationCapture, counts: () => ({ prepares, effects, commits }),
    expire: () => { now = new Date('2026-11-19T15:00:05.000Z'); },
    allow: (value: boolean) => { permitted = value; }, failCommit: (value: boolean) => { failCommit = value; },
    failAfterEffect: (value: boolean) => { failAfterEffect = value; }, failLookup: (value: boolean) => { failLookup = value; } };
}

async function endCoverage(f: Awaited<ReturnType<typeof fixture>>, action: LifecycleAction, at: string) {
  const change: LifecycleChange = { changeId: randomUUID(), policyId: f.context.policyId, action, reason: 'customer_request', at,
    replacementPolicyId: action === 'cancelled' ? null : randomUUID(), sourceDocumentHash: f.context.documentHash,
    replacementDocumentHash: action === 'cancelled' ? null : 'e'.repeat(64), refund: 'not_automated',
    ruleVersion: 'academic-policy-lifecycle-1', documentHash: '' };
  change.documentHash = await f.integrity.digest(lifecycleContent(change));
  f.context.lifecycle = change;
}

for (const action of ['cancelled', 'modified', 'renewed'] as const) {
  test(`${action} coverage rejects a new payment at or after its contractual end and accepts an earlier occurrence`, async () => {
    for (const offset of [-1, 0, 1]) {
      const f = await fixture(); const at = '2026-11-01T00:00:00.000Z';
      await endCoverage(f, action, at); f.context.occurredAt = new Date(Date.parse(at) + offset).toISOString();
      const result = await f.service.request(f.context.claimId, { amount: '1000.0000' }, f.actor);
      assert.equal(result.status, offset < 0 ? 'ok' : 'conflict');
      assert.deepEqual(f.counts(), { prepares: offset < 0 ? 1 : 0, effects: 0, commits: 0 });
      if (offset < 0) {
        assert.deepEqual(f.capture()?.inputs.policyLifecycle, f.context.lifecycle);
        assert.equal(f.capture()?.rule.version, '2');
      }
    }
  });

  test(`${action} coverage preserves replay, recovery and owner receipts for an already accepted payment`, async () => {
    const f = await fixture(); const result = await f.service.request(f.context.claimId, { amount: '1000.0000' }, f.actor);
    assert.equal(result.status, 'ok'); if (result.status !== 'ok') return;
    f.failAfterEffect(true); assert.equal((await f.service.recoverPayment(result.payment.paymentId)).status, 'unavailable');
    await endCoverage(f, action, '2026-11-02T00:00:00.000Z');
    const replay = await f.service.request(f.context.claimId, { amount: '1000.0000' }, f.actor);
    assert.equal(replay.status === 'ok' && replay.replayed, true);
    f.failAfterEffect(false); assert.equal((await f.service.recoverPayment(result.payment.paymentId)).status, 'confirmed');
    assert.equal((await f.service.owned({ clientId: f.context.offer.clientId, subjectToken: f.context.ownerSubjectToken }, f.actor.traceId)).items[0].payment.status, 'confirmed');
    assert.deepEqual(f.counts(), { prepares: 1, effects: 1, commits: 1 });
  });
}

test('altered lifecycle seals and policy or document bindings cannot authorize a payment', async () => {
  for (const field of ['documentHash', 'policyId', 'sourceDocumentHash'] as const) {
    const f = await fixture(); await endCoverage(f, 'cancelled', '2026-11-02T00:00:00.000Z');
    f.context.lifecycle![field] = field === 'policyId' ? randomUUID() : '0'.repeat(64);
    if (field !== 'documentHash') f.context.lifecycle!.documentHash = await f.integrity.digest(lifecycleContent(f.context.lifecycle!));
    await assert.rejects(f.service.request(f.context.claimId, { amount: '1000.0000' }, f.actor), /integrity/);
    assert.deepEqual(f.counts(), { prepares: 0, effects: 0, commits: 0 });
  }
});

test('a payout is a positive decimal amount within the remaining coverage, without floating-point rounding', () => {
  assert.deepEqual(parseDisbursement({ amount: '0.0001' }), { amount: '0.0001' });
  for (const input of [null, {}, { amount: 5 }, { amount: '0.0000' }, { amount: '1e3' }, { amount: '1.00001' },
    { amount: '01.0000' }, { amount: '5.0000', owner: 'other' }]) assert.equal(parseDisbursement(input), null);
  assert.equal(amountWithinCoverage('0.0001', '999999999999999.9999', '999999999999999.9998'), true);
  assert.equal(amountWithinCoverage('0.0002', '999999999999999.9999', '999999999999999.9998'), false);
});

test('authorization durably creates an intent before any provider call, with stable replay and conflicting amount rejection', async () => {
  const f = await fixture();
  const result = await f.service.request(f.context.claimId, { amount: '1000.0000' }, f.actor);
  assert.equal(result.status, 'ok'); assert.equal(f.counts().effects, 0);
  const replay = await f.service.request(f.context.claimId, { amount: '1000.0000' }, f.actor);
  assert.equal(replay.status === 'ok' && replay.replayed, true);
  assert.deepEqual(await f.service.request(f.context.claimId, { amount: '1001.0000' }, f.actor), { status: 'conflict' });
  assert.equal(f.counts().prepares, 1);
});

test('an expired or foreign analyst cannot create or read a payment intent', async () => {
  const f = await fixture(); f.allow(false);
  assert.deepEqual(await f.service.request(f.context.claimId, { amount: '1000.0000' }, f.actor), { status: 'not_found' });
  assert.equal(await f.service.read(f.context.claimId, f.actor), null);
  f.expire(); await assert.rejects(f.service.request(f.context.claimId, { amount: '1000.0000' }, f.actor), /authorization_expired/);
  assert.deepEqual(f.counts(), { prepares: 0, effects: 0, commits: 0 });
});

test('the approved amount cannot exceed coverage already reserved by another claim', async () => {
  const f = await fixture(); f.context.reservedAmount = '99999.9999';
  assert.deepEqual(await f.service.request(f.context.claimId, { amount: '0.0002' }, f.actor), { status: 'invalid_amount' });
  assert.equal(f.counts().prepares, 0);
  assert.equal((await f.service.request(f.context.claimId, { amount: '0.0001' }, f.actor)).status, 'ok');
  assert.equal(f.capture()?.inputs.reservedAmount, '99999.9999');
  assert.equal(f.capture()?.inputs.coverageLimit, '100000.0000');
});

test('provider confirmation survives a failed local commit and recovery never repeats the financial effect', async () => {
  const f = await fixture(); const prepared = await f.service.request(f.context.claimId, { amount: '1000.0000' }, f.actor);
  assert.equal(prepared.status, 'ok'); if (prepared.status !== 'ok') return;
  f.failCommit(true); assert.equal((await f.service.recoverPayment(prepared.payment.paymentId)).status, 'unavailable');
  assert.equal(f.context.payment?.status, 'pending'); assert.equal(f.counts().effects, 1);
  f.failCommit(false); assert.equal((await f.service.reconcile())[0].status, 'confirmed');
  assert.equal(f.context.state, 'paid'); assert.equal(f.counts().effects, 1); assert.equal(f.counts().commits, 1);
  assert.equal((await f.service.recoverPayment(prepared.payment.paymentId)).status, 'unchanged');
  assert.deepEqual(await f.service.reconcile(), []);
});

test('a lost settlement response stays pending and lookup recovers the same payment', async () => {
  const f = await fixture(); const result = await f.service.request(f.context.claimId, { amount: '1000.0000' }, f.actor);
  assert.equal(result.status, 'ok'); if (result.status !== 'ok') return;
  f.failAfterEffect(true); assert.equal((await f.service.recoverPayment(result.payment.paymentId)).status, 'unavailable');
  assert.equal(f.context.state, 'approved'); assert.equal(f.context.payment?.providerReference, null);
  f.failAfterEffect(false); assert.equal((await f.service.recoverPayment(result.payment.paymentId)).status, 'confirmed');
  assert.equal(f.counts().effects, 1);
});

test('provider lookup failure prevents a new settlement and preserves the pending intent', async () => {
  const f = await fixture(); const result = await f.service.request(f.context.claimId, { amount: '1000.0000' }, f.actor);
  assert.equal(result.status, 'ok'); if (result.status !== 'ok') return;
  f.failLookup(true); assert.equal((await f.service.recoverPayment(result.payment.paymentId)).status, 'unavailable');
  assert.equal(f.counts().effects, 0); assert.equal(f.context.payment?.status, 'pending');
});

test('changed payment fields or issuance evidence never reach the gateway', async () => {
  for (const tamper of [(c: DisbursementContext) => { c.timeSeal = '0'.repeat(64); },
    (c: DisbursementContext) => { c.occurredAt = '2025-01-01T00:00:00.000Z'; },
    (c: DisbursementContext) => { c.payment = { ...c.payment!, amount: '2000.0000' }; }]) {
    const f = await fixture(); const result = await f.service.request(f.context.claimId, { amount: '1000.0000' }, f.actor);
    assert.equal(result.status, 'ok'); if (result.status !== 'ok') return;
    tamper(f.context); assert.equal((await f.service.recoverPayment(result.payment.paymentId)).status, 'unavailable'); assert.equal(f.counts().effects, 0);
  }
});

test('a declined provider result is terminal, never paid or retried', async () => {
  const f = await fixture(); const result = await f.service.request(f.context.claimId, { amount: '1000.0000' }, f.actor);
  assert.equal(result.status, 'ok'); if (result.status !== 'ok') return;
  f.gateway.settle = async () => ({ status: 'declined', reference: null });
  assert.equal((await f.service.recoverPayment(result.payment.paymentId)).status, 'declined');
  assert.equal(f.context.state, 'approved'); assert.equal(f.context.payment?.status, 'declined');
  f.context.reservedAmount = '100000.0000';
  assert.equal((await f.service.read(f.context.claimId, f.actor))?.status, 'declined');
  const replay = await f.service.request(f.context.claimId, { amount: '1000.0000' }, f.actor);
  assert.equal(replay.status === 'ok' && replay.replayed && replay.payment.status === 'declined', true);
  assert.deepEqual(await f.service.reconcile(), []);
});

test('a provider deadline never fabricates confirmation', async () => {
  const f = await fixture(); await f.service.request(f.context.claimId, { amount: '1000.0000' }, f.actor);
  const service = new ClaimDisbursements(f.store, f.gateway, f.integrity, { race: async () => 'expired' },
    { now: () => new Date('2026-11-19T15:00:00.000Z'), newId: randomUUID }, true);
  assert.equal((await service.reconcile())[0].status, 'unavailable'); assert.equal(f.counts().effects, 0);
});

test('HTTP uses the operation grant, validates the amount and exposes only the committed pending receipt', async () => {
  const f = await fixture();
  // The boundary uses its real wall-clock authorization lease; application tests above use a separate deterministic clock.
  let calls = 0, dispatches = 0, operation = '';
  const payment = { paymentId: randomUUID(), amount: '1000.0000', currency: 'COP' as const, status: 'pending' as const, reference: null, simulated: true as const };
  const app = new Hono<{ Bindings: PolicyEnv }>();
  mountClaims(app, { inbox: { list: async () => ({ items: [], next: null }) },
    disbursements: { request: async () => { calls++; return { status: 'ok', payment, replayed: false }; }, read: async () => payment,
      owned: async () => ({ items: [], next: null }) },
    dispatchDisbursement: () => { dispatches++; },
    authorize: async input => { operation = input.operation; return { allowed: true, actor: { kind: 'user', channel: 'web', operations: [input.operation],
      principal: { clientId: f.actor.clientId, subjectToken: f.actor.subjectToken }, authorizationExpiresAt: new Date(Date.now() + 4000).toISOString() } }; } });
  const send = (body: unknown) => app.request('http://localhost/api/v1/claims/' + f.context.claimId + '/disbursement',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, { APP_ENV: 'local' } as PolicyEnv);
  assert.equal((await send({ amount: '-1.0000' })).status, 400); assert.equal(calls, 0);
  const response = await send({ amount: '1000.0000' }); assert.equal(response.status, 202); assert.equal(operation, 'claims:decide');
  const body = await response.json() as { payment: typeof payment; traceId: string }; assert.deepEqual(body.payment, payment);
  const spec = parse(await readFile(new URL('../packages/contracts/openapi/v1/claims.yaml', import.meta.url), 'utf8'));
  const ajv = new Ajv({ strict: false }); addFormats(ajv);
  const validate = ajv.compile(spec.components.schemas.ClaimDisbursementReceipt);
  assert.ok(validate(body), JSON.stringify(validate.errors));
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(dispatches, 1);
  assert.equal((await app.request('http://localhost/api/v1/claims/' + f.context.claimId + '/disbursement', {}, { APP_ENV: 'local' } as PolicyEnv)).status, 200);
  assert.equal(operation, 'claims:read');
});

test('parametric coverage cannot acquire a second manual payment engine', async () => {
  const f = await fixture();
  f.context.offer = { ...f.context.offer, product: 'flight_delay', coverage: { kind: 'flight_delay', flightReference: randomUUID(), thresholdMinutes: 180, payoutAmount: '100000.0000' } };
  f.context.termsHash = await f.integrity.digest(offerContent(f.context.offer));
  assert.deepEqual(await f.service.request(f.context.claimId, { amount: '1000.0000' }, f.actor), { status: 'conflict' });
  assert.deepEqual(f.counts(), { prepares: 0, effects: 0, commits: 0 });
});

test('HTTP returns conflict without dispatching settlement for an occurrence at the contractual end', async () => {
  const f = await fixture(); await endCoverage(f, 'cancelled', f.context.occurredAt);
  let dispatches = 0;
  const app = new Hono<{ Bindings: PolicyEnv }>();
  mountClaims(app, { inbox: { list: async () => ({ items: [], next: null }) }, disbursements: f.service,
    dispatchDisbursement: () => { dispatches++; },
    authorize: async input => ({ allowed: true, actor: { kind: 'user', channel: 'web', operations: [input.operation],
      principal: { clientId: f.actor.clientId, subjectToken: f.actor.subjectToken }, authorizationExpiresAt: new Date(Date.now() + 4000).toISOString() } }) });
  const response = await app.request('http://localhost/api/v1/claims/' + f.context.claimId + '/disbursement',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: '1000.0000' }) }, { APP_ENV: 'local' } as PolicyEnv);
  assert.equal(response.status, 409); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(dispatches, 0); assert.deepEqual(f.counts(), { prepares: 0, effects: 0, commits: 0 });
});

test('the owner sees the actual pending and confirmed payment and malformed ownership never releases a receipt', async () => {
  const f = await fixture(); const owner = { clientId: f.context.offer.clientId, subjectToken: f.context.ownerSubjectToken };
  assert.deepEqual(await f.service.owned(owner, f.actor.traceId), { items: [], next: null });
  await f.service.request(f.context.claimId, { amount: '1000.0000' }, f.actor);
  assert.equal((await f.service.owned(owner, f.actor.traceId)).items[0].payment.status, 'pending');
  await f.service.recoverPayment(f.context.payment!.id);
  const page = await f.service.owned(owner, f.actor.traceId);
  assert.equal(page.items[0].payment.status, 'confirmed');
  assert.equal(page.items[0].payment.reference, 'MOCK-' + f.context.payment!.id);
  assert.ok(parseClaimPaymentPage({ ...page, traceId: f.actor.traceId }));
  await assert.rejects(f.service.owned({ ...owner, subjectToken: randomUUID() }, f.actor.traceId), /integrity/);
  assert.deepEqual(f.counts(), { prepares: 1, effects: 1, commits: 1 });
});

test('native receipts require a bearer owner session and validate the query after authorization', async () => {
  const f = await fixture(); const owner = { clientId: f.context.offer.clientId, subjectToken: f.context.ownerSubjectToken };
  await f.service.request(f.context.claimId, { amount: '1000.0000' }, f.actor);
  const app = new Hono<{ Bindings: PolicyEnv }>(); let authorizations = 0;
  mountClaimReport(app, { disbursements: f.service,
    report: { create: async () => { throw Error('unexpected write'); }, receive: async () => { throw Error('unexpected write'); }, submit: async () => { throw Error('unexpected write'); } },
    authorize: async input => { authorizations++; assert.equal(input.operation, 'claims:report'); return { allowed: true,
      actor: { kind: 'user', channel: 'mobile', operations: ['claims:report'], principal: owner } }; } });
  const path = 'http://localhost/api/v1/claims/native/disbursements';
  assert.equal((await app.request(path, { headers: { cookie: 'solventa-session=synthetic' } })).status, 401);
  assert.equal(authorizations, 0);
  const response = await app.request(path, { headers: { authorization: 'Bearer synthetic-token' } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json(); assert.ok(parseClaimPaymentPage(body));
  const spec = parse(await readFile(new URL('../packages/contracts/openapi/v1/claims.yaml', import.meta.url), 'utf8'));
  const ajv = new Ajv({ strict: false }); addFormats(ajv);
  const validate = ajv.compile({ ...spec.components.schemas.OwnClaimPaymentPage, components: spec.components });
  assert.ok(validate(body), JSON.stringify(validate.errors));
  assert.equal((await app.request(path + '?cursor=bad', { headers: { authorization: 'Bearer synthetic-token' } })).status, 400);
  assert.equal((await app.request(path, { method: 'POST', headers: { authorization: 'Bearer synthetic-token' } })).status, 405);
  assert.equal(authorizations, 2);
});
