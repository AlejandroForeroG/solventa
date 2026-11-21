import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaimPayments } from '../apps/mobile/src/features/claim-payments/application/claim-payments';
import { createClaimPaymentsApi } from '../apps/mobile/src/features/claim-payments/adapters/payments-api';
import { ClaimPaymentFailure } from '../apps/mobile/src/features/claim-payments/domain/payment';
import { parseClaimPaymentPage } from '../packages/contracts/src/claim-payments';
import examples from '../packages/contracts/examples/claim-payments.json';
import { AuthFailure } from '../apps/mobile/src/features/authentication/domain/session';
import { formatPaymentAmount } from '../apps/mobile/src/features/claim-payments/presentation/format';

const owner = { clientId: '11111111-1111-4111-8111-111111111114', subjectToken: '11111111-1111-4111-8111-111111111115' };
const page = parseClaimPaymentPage(examples.confirmedPage)!;

test('native receipts preserve every decimal at the contract limits in both locales', () => {
  assert.equal(formatPaymentAmount('1250.1234', 'es-CO'), '1.250,1234 COP');
  assert.equal(formatPaymentAmount('1250.1234', 'en-US'), '1,250.1234 COP');
  assert.equal(formatPaymentAmount('999999999999999.9999', 'es-CO'), '999.999.999.999.999,9999 COP');
  assert.equal(formatPaymentAmount('999999999999999.9999', 'en-US'), '999,999,999,999,999.9999 COP');
  assert.equal(formatPaymentAmount('0.0001', 'es-CO'), '0,0001 COP');
});

test('native unauthorized responses reach session handling before the screen receives a safe failure', async () => {
  let unauthorized = false;
  const api = createClaimPaymentsApi('https://dev.solventa.site', { execute: async work => {
    try { return await work('synthetic-token'); } catch (error) {
      unauthorized = error instanceof AuthFailure && error.kind === 'unauthorized'; throw error;
    }
  } }, owner, async () => new Response(null, { status: 401 }));
  await assert.rejects(api.list(undefined, new AbortController().signal), (error: unknown) => error instanceof ClaimPaymentFailure && error.code === 'unauthorized');
  assert.equal(unauthorized, true);
});
test('a native receipt uses its expected owner session, bearer-only transport and the real validated receipt', async () => {
  let calls = 0;
  const api = createClaimPaymentsApi('https://dev.solventa.site', { execute: (work, expected) => {
    assert.deepEqual(expected, owner); return work('synthetic-token');
  } }, owner, async (url, init) => {
    calls++; assert.equal(String(url), 'https://dev.solventa.site/api/v1/claims/native/disbursements');
    assert.equal(init?.method, 'GET'); assert.equal(init?.credentials, 'omit');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-token');
    return new Response(JSON.stringify(examples.confirmedPage), { headers: { 'content-type': 'application/json' } });
  });
  assert.deepEqual(await api.list(undefined, new AbortController().signal), page); assert.equal(calls, 1);
});
test('background locking purges a native receipt and discards an old in-flight answer', async () => {
  let deliver: ((value: typeof page) => void) | undefined;
  const payments = new ClaimPayments({ list: async () => new Promise(resolve => { deliver = resolve; }) });
  const work = payments.refresh(); payments.lock(); deliver!(page); await work;
  assert.deepEqual(payments.getSnapshot(), { status: 'locked' });
});
test('refresh failures never retain a previously confirmed receipt as current', async () => {
  let failed = false;
  const payments = new ClaimPayments({ list: async () => { if (failed) throw new ClaimPaymentFailure('forbidden'); return page; } });
  await payments.refresh(); assert.equal(payments.getSnapshot().status, 'ready'); failed = true;
  await payments.refresh(); assert.deepEqual(payments.getSnapshot(), { status: 'failed', failure: 'forbidden' });
});
test('malformed confirmation or financial fields fail closed without a fabricated receipt', () => {
  for (const change of [{ reference: null }, { amount: '1e3' }, { currency: 'USD' }, { simulated: false }]) {
    const value = { ...examples.confirmedPage, items: [{ ...examples.confirmedPage.items[0], payment: { ...examples.confirmedPage.items[0].payment, ...change } }] };
    assert.equal(parseClaimPaymentPage(value), null);
  }
});
