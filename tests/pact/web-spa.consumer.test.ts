import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchersV3, PactV3 } from '@pact-foundation/pact';
import { fetchSession, requestLogout } from '../../apps/web/src/api/auth';
import { declineConsent, getTerms, grantConsent, listConsents, revokeConsent } from '../../apps/web/src/consent/api';
import { SUPPORTED_TERMS } from '../../apps/web/src/consent/wording';
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
      .willRespondWith({ status: 200 });
    await pact.executeTest(async server => assert.equal(await fetchSession(server.url), 'authenticated'));
  });

  test('reports an anonymous visitor', async () => {
    pact.given('no active session').uponReceiving('a session check without a session')
      .withRequest({ method: 'GET', path: '/auth/session' })
      .willRespondWith({ status: 401 });
    await pact.executeTest(async server => assert.equal(await fetchSession(server.url), 'anonymous'));
  });

  test('reports unavailable when authentication is not configured', async () => {
    pact.given('authentication is not configured').uponReceiving('a session check while authentication is unavailable')
      .withRequest({ method: 'GET', path: '/auth/session' })
      .willRespondWith({ status: 503 });
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
      .willRespondWith({ status: 401 });
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
          sumInsured: MatchersV3.integer(320000000),
          termMonths: MatchersV3.integer(180),
          validUntil: MatchersV3.iso8601DateTimeWithMillis('2026-10-21T15:00:00.000Z'),
          traceId,
        },
      });
    await pact.executeTest(async server => {
      const outcome = await submitQuote(server.url);
      assert.equal(outcome.kind, 'quote');
      if (outcome.kind === 'quote') assert.match(outcome.quote.quoteId, /^COT-\d{4}-\d{5}$/);
    });
  });

  test('receives the field errors of an invalid request', async () => {
    const invalid = { ...quoteValues, amount: '0' };
    pact.given('a customer with quote access').uponReceiving('a quote request with an invalid amount')
      .withRequest({ ...quoteRequest, body: toRequestBody(invalid, quoteKey) })
      .willRespondWith({
        status: 400,
        headers: jsonResponse,
        body: { errors: MatchersV3.eachLike({ field: MatchersV3.equal('credit.amount'), code: MatchersV3.equal('amount_out_of_range') }) },
      });
    await pact.executeTest(async server => {
      const outcome = await submitQuote(server.url, invalid);
      assert.equal(outcome.kind, 'validation');
    });
  });

  test('asks the visitor to sign in when the session cannot be renewed', async () => {
    pact.given('no active session').uponReceiving('a quote request without a session')
      .withRequest({ ...quoteRequest, body: toRequestBody(quoteValues, quoteKey) })
      .willRespondWith({ status: 401 });
    pact.given('no active session').uponReceiving('the session renewal after a rejected quote request')
      .withRequest({ method: 'GET', path: '/auth/session' })
      .willRespondWith({ status: 401 });
    await pact.executeTest(async server => assert.deepEqual(await submitQuote(server.url), { kind: 'unauthenticated' }));
  });

  test('shows access denied with the trace identifier', async () => {
    pact.given('a customer without permission to quote').uponReceiving('a quote request without permission')
      .withRequest({ ...quoteRequest, body: toRequestBody(quoteValues, quoteKey) })
      .willRespondWith({ status: 403, headers: { 'x-trace-id': traceId } });
    await pact.executeTest(async server => {
      const outcome = await submitQuote(server.url);
      assert.equal(outcome.kind, 'denied');
      if (outcome.kind === 'denied') assert.ok(outcome.traceId);
    });
  });

  test('reports a reused idempotency key as a conflict', async () => {
    pact.given('the idempotency key was used with another request', { idempotencyKey: quoteKey }).uponReceiving('a quote request reusing an idempotency key')
      .withRequest({ ...quoteRequest, body: toRequestBody(quoteValues, quoteKey) })
      .willRespondWith({ status: 409 });
    await pact.executeTest(async server => assert.deepEqual(await submitQuote(server.url), { kind: 'conflict' }));
  });

  test('reports the service as unavailable when Acquisition does not answer', async () => {
    pact.given('the quote service is down').uponReceiving('a quote request while the service is down')
      .withRequest({ ...quoteRequest, body: toRequestBody(quoteValues, quoteKey) })
      .willRespondWith({ status: 503 });
    await pact.executeTest(async server => assert.deepEqual(await submitQuote(server.url), { kind: 'unavailable' }));
  });
});

const consentKey = '22222222-2222-4222-8222-222222222222';
const consentRef = 'COT-2026-00001';
const consentPost = { method: 'POST', headers: { 'content-type': 'application/json' } };
const grantRequest = { ...consentPost, path: '/api/v1/consents', headers: { ...consentPost.headers, 'idempotency-key': consentKey } };
const grantBody = { textVersion: 2, locale: 'es-CO', quoteRef: consentRef };
const consentBody = (overrides: object = {}) => ({
  consentId: MatchersV3.regex('^CNS-\\d{4}-\\d{5,19}$', 'CNS-2026-00001'),
  status: MatchersV3.regex('^(active|revoked|expired)$', 'active'),
  sources: MatchersV3.eachLike('open_finance_bancolombia'),
  scopes: MatchersV3.eachLike('income_obligations_12m'),
  grantedAt: MatchersV3.iso8601DateTimeWithMillis('2026-10-08T15:00:00.000Z'),
  expiresAt: MatchersV3.iso8601DateTimeWithMillis('2027-01-06T15:00:00.000Z'),
  revokedAt: null,
  seal: MatchersV3.regex('^[0-9a-f]{64}$', 'a'.repeat(64)),
  ...overrides,
});

describe('SPA consent terms', () => {
  test('receives the authorization terms', async () => {
    pact.given('a customer ready to authorize consent').uponReceiving('a request for the consent terms')
      .withRequest({ method: 'GET', path: '/api/v1/consents/terms' })
      .willRespondWith({
        status: 200,
        headers: jsonResponse,
        body: {
          ...SUPPORTED_TERMS,
          sources: SUPPORTED_TERMS.sources.map(source => ({ ...source })),
        },
      });
    await pact.executeTest(async server => {
      const outcome = await withServer(server.url, () => getTerms());
      assert.equal(outcome.kind, 'ok');
      if (outcome.kind === 'ok') assert.equal(outcome.value.textVersion, 2);
    });
  });

  test('asks the visitor to sign in when the session cannot be renewed', async () => {
    pact.given('no active session').uponReceiving('a request for the consent terms without a session')
      .withRequest({ method: 'GET', path: '/api/v1/consents/terms' })
      .willRespondWith({ status: 401 });
    pact.given('no active session').uponReceiving('the session renewal after a rejected consent request')
      .withRequest({ method: 'GET', path: '/auth/session' })
      .willRespondWith({ status: 401 });
    await pact.executeTest(async server => assert.deepEqual(await withServer(server.url, () => getTerms()), { kind: 'unauthenticated' }));
  });

  test('reports the service as unavailable when Identity does not answer', async () => {
    pact.given('the consent service is down').uponReceiving('a request for the consent terms while the service is down')
      .withRequest({ method: 'GET', path: '/api/v1/consents/terms' })
      .willRespondWith({ status: 503 });
    await pact.executeTest(async server => assert.deepEqual(await withServer(server.url, () => getTerms()), { kind: 'unavailable' }));
  });
});

describe('SPA consent authorization', () => {
  test('receives the created consent', async () => {
    pact.given('a customer ready to authorize consent').uponReceiving('a consent authorization')
      .withRequest({ ...grantRequest, body: grantBody })
      .willRespondWith({ status: 201, headers: jsonResponse, body: consentBody() });
    await pact.executeTest(async server => {
      const outcome = await withServer(server.url, () => grantConsent(grantBody, consentKey));
      assert.equal(outcome.kind, 'ok');
      if (outcome.kind === 'ok') assert.match(outcome.value.consentId, /^CNS-\d{4}-\d{5}$/);
    });
  });

  test('receives the same consent when the request is retried', async () => {
    pact.given('the consent was already granted with the idempotency key', { idempotencyKey: consentKey }).uponReceiving('a retried consent authorization')
      .withRequest({ ...grantRequest, body: grantBody })
      .willRespondWith({ status: 200, headers: jsonResponse, body: consentBody() });
    await pact.executeTest(async server => assert.equal((await withServer(server.url, () => grantConsent(grantBody, consentKey))).kind, 'ok'));
  });

  test('reports an outdated text version', async () => {
    const outdated = { ...grantBody, textVersion: 3 };
    pact.given('a customer ready to authorize consent').uponReceiving('a consent authorization with an outdated text version')
      .withRequest({ ...grantRequest, body: outdated })
      .willRespondWith({ status: 409, headers: jsonResponse, body: { error: MatchersV3.equal('terms_outdated') } });
    await pact.executeTest(async server => assert.deepEqual(await withServer(server.url, () => grantConsent(outdated, consentKey)), { kind: 'outdated' }));
  });

  test('reports a reused idempotency key as a conflict', async () => {
    pact.given('the idempotency key was used for another consent request', { idempotencyKey: consentKey }).uponReceiving('a consent authorization reusing an idempotency key')
      .withRequest({ ...grantRequest, body: grantBody })
      .willRespondWith({ status: 409, headers: jsonResponse, body: { error: MatchersV3.equal('idempotency_key_reused') } });
    await pact.executeTest(async server => assert.deepEqual(await withServer(server.url, () => grantConsent(grantBody, consentKey)), { kind: 'conflict' }));
  });

  test('reports the service as unavailable when Identity does not answer', async () => {
    pact.given('the consent service is down').uponReceiving('a consent authorization while the service is down')
      .withRequest({ ...grantRequest, body: grantBody })
      .willRespondWith({ status: 503 });
    await pact.executeTest(async server => assert.deepEqual(await withServer(server.url, () => grantConsent(grantBody, consentKey)), { kind: 'unavailable' }));
  });
});

describe('SPA consent refusal', () => {
  test('records the refusal without content', async () => {
    pact.given('a customer ready to authorize consent').uponReceiving('a consent refusal')
      .withRequest({ ...consentPost, path: '/api/v1/consents/declines', body: { textVersion: 2 } })
      .willRespondWith({ status: 204 });
    await pact.executeTest(async server => assert.deepEqual(await withServer(server.url, () => declineConsent(2)), { kind: 'ok', value: true }));
  });
});

describe('SPA privacy panel', () => {
  test('receives the consents of the customer', async () => {
    pact.given('a customer with an active consent').uponReceiving('a request for the consents of the customer')
      .withRequest({ method: 'GET', path: '/api/v1/consents' })
      .willRespondWith({ status: 200, headers: jsonResponse, body: { items: MatchersV3.eachLike(consentBody()) } });
    await pact.executeTest(async server => {
      const outcome = await withServer(server.url, () => listConsents());
      assert.equal(outcome.kind, 'ok');
      if (outcome.kind === 'ok') assert.equal(outcome.value.length, 1);
    });
  });

  test('receives the revoked consent', async () => {
    pact.given('a customer with an active consent').uponReceiving('a consent revocation')
      .withRequest({ ...consentPost, path: '/api/v1/consents/CNS-2026-00001/revoke', body: {} })
      .willRespondWith({
        status: 200,
        headers: jsonResponse,
        body: consentBody({ status: MatchersV3.equal('revoked'), revokedAt: MatchersV3.iso8601DateTimeWithMillis('2026-10-08T15:00:00.000Z') }),
      });
    await pact.executeTest(async server => {
      const outcome = await withServer(server.url, () => revokeConsent('CNS-2026-00001'));
      assert.equal(outcome.kind, 'ok');
      if (outcome.kind === 'ok') assert.equal(outcome.value.status, 'revoked');
    });
  });

  test('reports a consent that does not exist', async () => {
    pact.given('a customer ready to authorize consent').uponReceiving('a revocation of an unknown consent')
      .withRequest({ ...consentPost, path: '/api/v1/consents/CNS-2026-99999/revoke', body: {} })
      .willRespondWith({ status: 404 });
    await pact.executeTest(async server => assert.deepEqual(await withServer(server.url, () => revokeConsent('CNS-2026-99999')), { kind: 'notFound' }));
  });
});
