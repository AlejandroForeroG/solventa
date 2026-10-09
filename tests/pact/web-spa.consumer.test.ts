import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchersV3, PactV3 } from '@pact-foundation/pact';
import { fetchSession, requestLogout } from '../../apps/web/src/api/auth';
import { requestQuote, toRequestBody } from '../../apps/web/src/quote/api';
import type { QuoteValues } from '../../apps/web/src/quote/api';
import { assertMatchesCommitted, pactOutputDir, providerName } from './support/pact-files';

const consumerName = 'solventa-web-spa';
const outputDir = pactOutputDir();
const jsonResponse = { 'Content-Type': 'application/json' };
const quoteKey = '11111111-1111-4111-8111-111111111111';
const quoteValues: QuoteValues = { fullName: 'Laura Catalina Restrepo Ochoa', documentNumber: '1020884771', birthDate: '1992-03-14', city: 'Bogotá D.C.', amount: '320000000', termMonths: '180' };
const quoteRequest = { method: 'POST', path: '/api/v1/me/quotes', headers: { 'content-type': 'application/json', 'idempotency-key': quoteKey, 'accept-language': 'es-CO' } };
const traceId = MatchersV3.uuid('7f3c2a9e-1b4d-4c8e-9a52-0d6e8f1a3b47');
const pact = new PactV3({ consumer: consumerName, provider: providerName, dir: outputDir, logLevel: 'error' });

after(() => assertMatchesCommitted(outputDir, `${consumerName}-${providerName}.json`));

describe('SPA session check', () => {
  test('reports an authenticated session', async () => {
    pact.given('an active session').uponReceiving('a session check with an active session')
      .withRequest({ method: 'GET', path: '/auth/session' })
      .willRespondWith({ status: 200, headers: jsonResponse, body: { authenticated: true } });
    await pact.executeTest(async server => assert.equal(await fetchSession(server.url), 'authenticated'));
  });

  test('reports an anonymous visitor', async () => {
    pact.given('no active session').uponReceiving('a session check without a session')
      .withRequest({ method: 'GET', path: '/auth/session' })
      .willRespondWith({ status: 401, headers: jsonResponse, body: { authenticated: false } });
    await pact.executeTest(async server => assert.equal(await fetchSession(server.url), 'anonymous'));
  });

  test('reports unavailable when authentication is not configured', async () => {
    pact.given('authentication is not configured').uponReceiving('a session check while authentication is unavailable')
      .withRequest({ method: 'GET', path: '/auth/session' })
      .willRespondWith({ status: 503, headers: jsonResponse, body: { error: 'authentication_unavailable' } });
    await pact.executeTest(async server => assert.equal(await fetchSession(server.url), 'unavailable'));
  });
});

describe('SPA logout', () => {
  test('receives the provider logout URL', async () => {
    pact.given('an active session').uponReceiving('a logout with an active session')
      .withRequest({ method: 'POST', path: '/auth/logout' })
      .willRespondWith({ status: 200, headers: jsonResponse, body: { logoutUrl: MatchersV3.regex('^https://.+', 'https://auth.example.invalid/logout') } });
    await pact.executeTest(async server => {
      assert.deepEqual(await requestLogout(server.url), { status: 'redirect', logoutUrl: 'https://auth.example.invalid/logout' });
    });
  });

  test('treats a missing session as already logged out', async () => {
    pact.given('no active session').uponReceiving('a logout without a session')
      .withRequest({ method: 'POST', path: '/auth/logout' })
      .willRespondWith({ status: 401, headers: jsonResponse, body: { authenticated: false } });
    await pact.executeTest(async server => assert.deepEqual(await requestLogout(server.url), { status: 'anonymous' }));
  });
});

// The quote client calls relative URLs, so requests are redirected to the Pact mock server.
async function withServer<T>(serverUrl: string, run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => realFetch(typeof input === 'string' && input.startsWith('/') ? serverUrl + input : input, init);
  try { return await run(); } finally { globalThis.fetch = realFetch; }
}
const submitQuote = (serverUrl: string, values = quoteValues) => withServer(serverUrl, () => requestQuote(values, quoteKey, 'es-CO'));

describe('SPA quote request', () => {
  test('receives the created quote', async () => {
    pact.given('a customer with quote access').uponReceiving('a quote request from a customer with access')
      .withRequest({ ...quoteRequest, body: toRequestBody(quoteValues, quoteKey) })
      .willRespondWith({
        status: 201,
        headers: jsonResponse,
        body: {
          quoteId: MatchersV3.regex('^COT-\\d{4}-\\d{5}$', 'COT-2026-00001'),
          premiumMonthly: MatchersV3.integer(86400),
          currency: 'COP',
          sumInsured: MatchersV3.integer(320000000),
          termMonths: MatchersV3.integer(180),
          validUntil: MatchersV3.iso8601DateTimeWithMillis('2026-10-21T15:00:00.000Z'),
          basis: 'minimum_data',
          ruleVersion: MatchersV3.string('2026.1'),
          traceId,
        },
      });
    await pact.executeTest(async server => {
      const outcome = await submitQuote(server.url);
      assert.equal(outcome.kind, 'quote');
      if (outcome.kind === 'quote') assert.equal(outcome.quote.currency, 'COP');
    });
  });

  test('receives the field errors of an invalid request', async () => {
    const invalid = { ...quoteValues, amount: '0' };
    pact.given('a customer with quote access').uponReceiving('a quote request with an invalid amount')
      .withRequest({ ...quoteRequest, body: toRequestBody(invalid, quoteKey) })
      .willRespondWith({
        status: 400,
        headers: jsonResponse,
        body: { error: 'validation_error', errors: MatchersV3.eachLike({ field: MatchersV3.string('credit.amount'), code: MatchersV3.string('out_of_range') }) },
      });
    await pact.executeTest(async server => {
      const outcome = await submitQuote(server.url, invalid);
      assert.equal(outcome.kind, 'validation');
    });
  });

  test('asks the visitor to sign in when the session cannot be renewed', async () => {
    pact.given('no active session').uponReceiving('a quote request without a session')
      .withRequest({ ...quoteRequest, body: toRequestBody(quoteValues, quoteKey) })
      .willRespondWith({ status: 401, headers: jsonResponse, body: { error: 'unauthorized' } });
    pact.given('no active session').uponReceiving('the session renewal after a rejected quote request')
      .withRequest({ method: 'GET', path: '/auth/session' })
      .willRespondWith({ status: 401, headers: jsonResponse, body: { authenticated: false } });
    await pact.executeTest(async server => assert.deepEqual(await submitQuote(server.url), { kind: 'unauthenticated' }));
  });

  test('shows access denied with the trace identifier', async () => {
    pact.given('a customer without permission to quote').uponReceiving('a quote request without permission')
      .withRequest({ ...quoteRequest, body: toRequestBody(quoteValues, quoteKey) })
      .willRespondWith({ status: 403, headers: { ...jsonResponse, 'x-trace-id': traceId }, body: { error: 'forbidden' } });
    await pact.executeTest(async server => {
      const outcome = await submitQuote(server.url);
      assert.equal(outcome.kind, 'denied');
      if (outcome.kind === 'denied') assert.ok(outcome.traceId);
    });
  });

  test('reports a reused idempotency key as a conflict', async () => {
    pact.given('the idempotency key was used with another request', { idempotencyKey: quoteKey }).uponReceiving('a quote request reusing an idempotency key')
      .withRequest({ ...quoteRequest, body: toRequestBody(quoteValues, quoteKey) })
      .willRespondWith({ status: 409, headers: jsonResponse, body: { error: 'idempotency_key_reused' } });
    await pact.executeTest(async server => assert.deepEqual(await submitQuote(server.url), { kind: 'conflict' }));
  });

  test('reports the service as unavailable when Acquisition does not answer', async () => {
    pact.given('the quote service is down').uponReceiving('a quote request while the service is down')
      .withRequest({ ...quoteRequest, body: toRequestBody(quoteValues, quoteKey) })
      .willRespondWith({ status: 503, headers: jsonResponse, body: { error: 'service_unavailable' } });
    await pact.executeTest(async server => assert.deepEqual(await submitQuote(server.url), { kind: 'unavailable' }));
  });
});
