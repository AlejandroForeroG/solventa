import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { CreateQuote } from '../backend/acquisition-risk/src/application/create-quote';
import { ageOn, monthlyPremium, RULE_VERSION, validateQuoteRequest } from '../backend/acquisition-risk/src/domain/quote';
import type { AccessCredential } from '../backend/acquisition-risk/src/application/ports/api-access';
import { InMemoryAccess, MemoryStore, OTHER_USER_ACTOR, PARTNER, PARTNER_ID, protector, USER_ACTOR, WEB } from './support/quote-fakes';

const examples = JSON.parse(readFileSync(new URL('../packages/contracts/examples/quotes.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-10-06T15:00:00Z'); // 10:00 in Bogota, same calendar day as examples.asOf
const TRACE = '7f3c2a9e-1b4d-4c8e-9a52-0d6e8f1a3b47';

function setup() {
  const store = new MemoryStore();
  const access = new InMemoryAccess();
  return { store, access, useCase: new CreateQuote({ access, store, clock: { now: () => NOW }, protector }) };
}
const base = examples.cases[0].request;
const call = (useCase: CreateQuote, over: Partial<{ credential: AccessCredential | null; idempotencyKey: string | null; body: unknown }> = {}) =>
  useCase.execute({ credential: PARTNER, idempotencyKey: 'key-1', body: base, traceId: TRACE, ...over });

for (const item of examples.cases) {
  test(`contract example: ${item.name}`, async () => {
    const { useCase, store } = setup();
    const result = await call(useCase, { body: item.request });
    assert.equal(result.status === 'created' ? 201 : 400, item.expected.status);
    if (result.status === 'created') {
      assert.equal(result.quote.premiumMonthly, item.expected.premiumMonthly);
      assert.equal(result.quote.currency, 'COP');
      assert.equal(result.quote.ruleVersion, RULE_VERSION);
      assert.equal(result.quote.sumInsured, item.request.credit.amount);
    } else {
      assert.equal(result.status, 'invalid');
      if (result.status === 'invalid') for (const expected of item.expected.errors) {
        const found = result.errors.find(e => e.field === expected.field && e.code === expected.code);
        assert.ok(found, `expected ${expected.field}/${expected.code} in ${JSON.stringify(result.errors)}`);
        if (expected.params) assert.deepEqual(found.params, expected.params);
      }
      assert.equal(store.saved.length, 0, 'an invalid request must not be stored');
    }
  });
}

test('age and premium follow the provisional rule', () => {
  assert.equal(ageOn('1992-03-14', '2026-10-06'), 34);
  assert.equal(ageOn('2008-10-07', '2026-10-06'), 17);
  assert.equal(monthlyPremium(320000000, 34), 86400);
  assert.equal(monthlyPremium(123456789, 34), 33333);
  assert.ok(monthlyPremium(Number.MAX_SAFE_INTEGER, 70) <= Number.MAX_SAFE_INTEGER);
  assert.throws(() => monthlyPremium(1000, 17));
  assert.throws(() => monthlyPremium(1000, 71));
});

test('the same input always gives the same premium, whatever the term', async () => {
  const { useCase } = setup();
  const a = await call(useCase, { idempotencyKey: 'k-a' });
  const b = await call(useCase, { idempotencyKey: 'k-b', body: { ...base, credit: { ...base.credit, termMonths: 60 } } });
  assert.ok(a.status === 'created' && b.status === 'created');
  if (a.status === 'created' && b.status === 'created') assert.equal(a.quote.premiumMonthly, b.quote.premiumMonthly);
});

test('age is taken on the Bogota calendar day, not the UTC one', async () => {
  // 2026-10-07T03:00Z is still 2026-10-06 in Bogota: a person born 2008-10-07 is 17.
  const useCase = new CreateQuote({ access: new InMemoryAccess(), store: new MemoryStore(), clock: { now: () => new Date('2026-10-07T03:00:00Z') }, protector });
  const result = await call(useCase, { body: { ...base, customer: { ...base.customer, birthDate: '2008-10-07' } } });
  assert.equal(result.status, 'invalid');
});

test('access outcomes keep their difference: 401, 403 and 503, and nothing is stored', async () => {
  const { useCase, store } = setup();
  const cases: [AccessCredential | null, number, string][] = [
    [null, 401, 'unauthorized'],
    [{ kind: 'partner', token: 'unknown-token' }, 401, 'unauthorized'],
    [{ kind: 'partner', token: 'no-scope-token' }, 403, 'forbidden'],
    [{ kind: 'partner', token: 'down-token' }, 503, 'access_unavailable'],
    [{ ...WEB, cookie: 'expired-cookie' }, 401, 'unauthorized'],
    [{ ...WEB, cookie: 'forbidden-origin-cookie' }, 403, 'forbidden']
  ];
  for (const [credential, httpStatus, error] of cases) assert.deepEqual(await call(useCase, { credential }), { status: 'denied', error, httpStatus });
  assert.equal(store.saved.length, 0);
});

test('without a credential Identity is not even asked', async () => {
  const { useCase, access } = setup();
  await call(useCase, { credential: null });
  assert.equal(access.calls.length, 0);
});

test('access is checked before validation, so a caller without access learns nothing about the rules', async () => {
  const { useCase } = setup();
  const result = await call(useCase, { credential: { kind: 'partner', token: 'unknown-token' }, body: { nonsense: true }, idempotencyKey: null });
  assert.equal(result.status, 'denied');
});

test('a partner quote is stored under the partner and the keyed hash of the document', async () => {
  const { useCase, store } = setup();
  assert.equal((await call(useCase)).status, 'created');
  const saved = store.saved[0];
  assert.deepEqual(saved.actor, { kind: 'partner', partnerId: PARTNER_ID });
  assert.equal(saved.subjectToken, await protector.documentToken(base.customer.documentNumber));
});

test('a web user quote hangs from the session subject, never from the document in the body', async () => {
  const { useCase, store } = setup();
  const result = await call(useCase, { credential: WEB });
  assert.equal(result.status, 'created');
  const saved = store.saved[0];
  assert.deepEqual(saved.actor, USER_ACTOR);
  assert.equal(saved.subjectToken, USER_ACTOR.kind === 'user' ? USER_ACTOR.subjectToken : '');
  assert.ok(!JSON.stringify(saved).includes(base.customer.documentNumber), 'the document number is not stored for a web user');
  const other = await call(useCase, { credential: { ...WEB, cookie: 'other-user-cookie' }, body: { ...base, customer: { ...base.customer, documentNumber: '1099999999' } } });
  assert.equal(other.status, 'created');
  assert.deepEqual(store.saved[1].actor, OTHER_USER_ACTOR);
});

test('idempotency is scoped per actor: the same key for two users creates two quotes', async () => {
  const { useCase, store } = setup();
  assert.equal((await call(useCase, { credential: WEB })).status, 'created');
  assert.equal((await call(useCase, { credential: { ...WEB, cookie: 'other-user-cookie' } })).status, 'created');
  assert.equal((await call(useCase, { credential: WEB })).status, 'replayed');
  assert.equal(store.saved.length, 2);
});

test('idempotency: same key and request replays, same key with other request conflicts', async () => {
  const { useCase, store } = setup();
  const first = await call(useCase);
  const replay = await call(useCase);
  assert.equal(first.status, 'created');
  assert.equal(replay.status, 'replayed');
  if (first.status === 'created' && replay.status === 'replayed') assert.equal(replay.quote.quoteId, first.quote.quoteId);
  assert.equal(store.saved.length, 1);
  const other = await call(useCase, { body: { ...base, credit: { ...base.credit, amount: 1000000 } } });
  assert.deepEqual(other, { status: 'idempotency_conflict' });
});

test('Idempotency-Key is required and bounded', async () => {
  const { useCase } = setup();
  assert.deepEqual(await call(useCase, { idempotencyKey: null }), { status: 'invalid', errors: [{ field: 'Idempotency-Key', code: 'required' }] });
  assert.deepEqual(await call(useCase, { idempotencyKey: '' }), { status: 'invalid', errors: [{ field: 'Idempotency-Key', code: 'required' }] });
  assert.equal((await call(useCase, { idempotencyKey: 'x'.repeat(129) })).status, 'invalid');
  assert.equal((await call(useCase, { idempotencyKey: 'x'.repeat(128) })).status, 'created');
});

test('no personal data reaches validation errors or the store as plain text', async () => {
  const { useCase, store } = setup();
  const bad = await call(useCase, { body: { ...base, customer: { ...base.customer, birthDate: '1952-03-14', documentNumber: 'ABC123' } } });
  const text = JSON.stringify(bad);
  for (const secret of ['ABC123', '1952-03-14', base.customer.fullName]) assert.ok(!text.includes(secret));
  await call(useCase);
  assert.equal(store.saved[0].subjectToken.includes(base.customer.documentNumber), false);
});

test('malformed bodies are rejected without throwing', () => {
  for (const body of [null, 'x', 5, [], {}, { ...base, extra: 1 }, { ...base, customer: 'x' }, { ...base, credit: { ...base.credit, amount: '5' } }, { ...base, credit: { ...base.credit, amount: 1.5 } }, { ...base, customer: { ...base.customer, birthDate: '2026-02-30' } }]) {
    assert.equal(validateQuoteRequest(body, '2026-10-06').ok, false);
  }
});

test('what is stored with each quote follows the decision capture schema and holds no personal data', async () => {
  const validate = new Ajv({ allErrors: true }).compile(JSON.parse(readFileSync('packages/contracts/schemas/decision-capture.v1.json', 'utf8')));
  for (const credential of [PARTNER, WEB]) {
    const { useCase, store } = setup();
    await call(useCase, { credential });
    const { capture } = store.saved[0];
    assert.equal(validate(capture), true, JSON.stringify(validate.errors));
    assert.deepEqual(capture.inputs, { product: 'vida_hipotecario', ageYears: 34, amount: 320000000, termMonths: 180, ratePpm: 270, partnerCreditId: 'CRE-88-2026' });
    assert.deepEqual(capture.consent, { status: 'not_required' });
    assert.deepEqual(capture.sources, []);
    assert.equal(capture.rule.version, RULE_VERSION);
    assert.equal(capture.outcome, 'quoted');
    assert.equal(monthlyPremium(capture.inputs.amount, capture.inputs.ageYears), 86400, 'the premium is reproducible from the captured inputs');
    assert.equal(capture.correlationId, TRACE);
    const text = JSON.stringify(capture);
    for (const secret of [base.customer.documentNumber, base.customer.fullName, base.customer.birthDate, base.customer.city]) assert.ok(!text.includes(secret));
  }
});
