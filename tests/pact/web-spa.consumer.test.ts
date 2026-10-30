import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchersV3, PactV3 } from '@pact-foundation/pact';
import { fetchSession, requestLogout } from '../../apps/web/src/api/auth';
import { declineConsent, getTerms, grantConsent, listConsents, revokeConsent } from '../../apps/web/src/consent/api';
import { SUPPORTED_TERMS } from '../../apps/web/src/consent/wording';
import { requestQuote, toRequestBody } from '../../apps/web/src/quote/api';
import type { QuoteValues } from '../../apps/web/src/quote/api';
import { requestEstimate } from '../../apps/web/src/quote/estimate-api';
import { acceptOffer, beginSignatureChallenge, chargePolicy, createOffer, issuePolicy, policyForAcceptance } from '../../apps/web/src/offer/api';
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

describe('SPA anonymous estimate', () => {
  const values = { ageYears: '34', amount: '320000000', termMonths: '180' };
  const request = { method: 'POST', path: '/api/v1/quote-estimates', headers: { 'content-type': 'application/json' } };
  test('calculates without a session or idempotency key', async () => {
    pact.given('no active session').uponReceiving('an anonymous indicative calculation')
      .withRequest({ ...request, body: { ageYears: 34, amount: 320000000, termMonths: 180 } })
      .willRespondWith({ status: 200, headers: jsonResponse, body: {
        premiumMonthly: MatchersV3.integer(86400), currency: MatchersV3.equal('COP'), sumInsured: MatchersV3.equal(320000000),
        termMonths: MatchersV3.equal(180), basis: MatchersV3.equal('minimum_data'), ruleVersion: MatchersV3.regex('^.+$', 'provisional-1'), traceId
      } });
    await pact.executeTest(async server => {
      const outcome = await withServer(server.url, () => requestEstimate(values));
      assert.equal(outcome.kind, 'estimate');
      if (outcome.kind === 'estimate') assert.equal(outcome.estimate.premiumMonthly, 86400);
    });
  });
  test('receives invalid calculator fields', async () => {
    pact.given('no active session').uponReceiving('an anonymous calculation with an unsupported age')
      .withRequest({ ...request, body: { ageYears: 17, amount: 320000000, termMonths: 180 } })
      .willRespondWith({ status: 400, headers: jsonResponse, body: { errors: [{ field: 'ageYears', code: 'age_out_of_range' }] } });
    await pact.executeTest(async server => assert.deepEqual(await withServer(server.url, () => requestEstimate({ ...values, ageYears: '17' })), { kind: 'invalid', fields: ['ageYears'] }));
  });
  test('reports a calculator outage', async () => {
    pact.given('the calculator is down').uponReceiving('an anonymous calculation while Acquisition is unavailable')
      .withRequest({ ...request, body: { ageYears: 34, amount: 320000000, termMonths: 180 } })
      .willRespondWith({ status: 503, headers: jsonResponse, body: { error: 'service_unavailable', traceId } });
    await pact.executeTest(async server => assert.deepEqual(await withServer(server.url, () => requestEstimate(values)), { kind: 'unavailable' }));
  });
});

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
          currency: MatchersV3.equal('COP'),
          sumInsured: MatchersV3.integer(320000000),
          termMonths: MatchersV3.integer(180),
          validUntil: MatchersV3.iso8601DateTimeWithMillis('2026-10-21T15:00:00.000Z'),
          basis: MatchersV3.equal('minimum_data'),
          ruleVersion: MatchersV3.regex('^.+$', 'provisional-1'),
          traceId,
        },
      });
    await pact.executeTest(async server => {
      const outcome = await submitQuote(server.url);
      assert.equal(outcome.kind, 'quote');
      if (outcome.kind === 'quote') assert.deepEqual(outcome.quote, {
        quoteId: 'COT-2026-00001', premiumMonthly: 86400, currency: 'COP', sumInsured: 320000000,
        termMonths: 180, validUntil: '2026-10-21T15:00:00.000Z', basis: 'minimum_data',
        ruleVersion: 'provisional-1', traceId: '7f3c2a9e-1b4d-4c8e-9a52-0d6e8f1a3b47'
      });
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
  test('follows the cursor to reach authorizations beyond the first bounded page', async () => {
    pact.given('a customer with 51 active consents').uponReceiving('the first bounded consent page')
      .withRequest({ method: 'GET', path: '/api/v1/consents' })
      .willRespondWith({ status: 200, headers: jsonResponse, body: { items: MatchersV3.eachLike(consentBody(), 50), nextCursor: MatchersV3.equal('CNS-2026-00050') } });
    pact.given('a customer with 51 active consents').uponReceiving('the next consent page using its cursor')
      .withRequest({ method: 'GET', path: '/api/v1/consents', query: { after: 'CNS-2026-00050' } })
      .willRespondWith({ status: 200, headers: jsonResponse, body: { items: [consentBody({ consentId: MatchersV3.equal('CNS-2026-00051') })], nextCursor: null } });
    await pact.executeTest(async server => {
      const first = await withServer(server.url, () => listConsents());
      assert.ok(first.kind === 'ok' && first.value.items.length === 50 && first.value.nextCursor);
      const next = await withServer(server.url, () => listConsents(undefined, first.value.nextCursor!));
      assert.ok(next.kind === 'ok' && next.value.items.length === 1 && next.value.nextCursor === null);
    });
  });

  test('receives the consents of the customer', async () => {
    pact.given('a customer with an active consent').uponReceiving('a request for the consents of the customer')
      .withRequest({ method: 'GET', path: '/api/v1/consents' })
      .willRespondWith({ status: 200, headers: jsonResponse, body: { items: MatchersV3.eachLike(consentBody()), nextCursor: null } });
    await pact.executeTest(async server => {
      const outcome = await withServer(server.url, () => listConsents());
      assert.equal(outcome.kind, 'ok');
      if (outcome.kind === 'ok') assert.equal(outcome.value.items.length, 1);
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

describe('SPA definitive offer and policy issuance', () => {
  const offerId = '10000000-0000-4000-8000-000000000001';
  const acceptanceId = '20000000-0000-4000-8000-000000000002';
  const policyId = '30000000-0000-4000-8000-000000000003';
  const documentHash = 'a'.repeat(64);
  const challengeId = '80000000-0000-4000-8000-000000000008';
  const code = '123456';
  const offerKey = '22222222-2222-4222-8222-222222222222';
  const post = (path: string, idempotencyKey: string, body: unknown) => ({ method: 'POST', path, headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey }, body });
  const money = (example: string) => MatchersV3.regex('^(0|[1-9][0-9]{0,14})\\.[0-9]{4}$', example);
  const instant = (example: string) => MatchersV3.iso8601DateTimeWithMillis(example);
  const offerBody = {
    offerId: MatchersV3.equal(offerId), offerVersion: MatchersV3.equal(1), quoteId: MatchersV3.equal('COT-2026-00001'), product: MatchersV3.equal('vida_hipotecario'),
    premium: money('77760.0000'), currency: MatchersV3.equal('COP'), coverage: { kind: MatchersV3.equal('mortgage_life'), sumInsured: money('320000000.0000') },
    effectiveFrom: instant('2026-10-15T00:00:00.000Z'), effectiveUntil: instant('2027-10-15T00:00:00.000Z'), expiresAt: instant('2026-10-15T00:15:00.000Z'),
    ruleVersion: MatchersV3.regex('^academic-[a-z0-9-]+$', 'academic-mortgage-1'), synthetic: MatchersV3.equal(true), status: MatchersV3.equal('definitive'), traceId,
  };
  const policyBody = (status: string) => ({
    policyId: MatchersV3.equal(policyId), offerId: MatchersV3.equal(offerId), offerVersion: MatchersV3.integer(1), status: MatchersV3.equal(status), premium: money('77760.0000'),
    currency: MatchersV3.equal('COP'), effectiveFrom: instant('2026-10-15T00:00:00.000Z'), effectiveUntil: instant('2027-10-15T00:00:00.000Z'),
    document: MatchersV3.regex('^\\{.+\\}$', '{"synthetic":true}'), documentHash: MatchersV3.equal(documentHash), synthetic: MatchersV3.equal(true),
    providerMode: MatchersV3.equal('mock'), replayed: MatchersV3.boolean(false), traceId,
  });
  const acceptance = { acceptanceId, offerId, acceptedAt: '2026-10-15T00:01:00.000Z', traceId: '7f3c2a9e-1b4d-4c8e-9a52-0d6e8f1a3b47' };

  test('creates a definitive offer from the saved quote', async () => {
    pact.given('a customer with a current consent and a saved quote').uponReceiving('a definitive offer request')
      .withRequest(post('/api/v1/quotes/COT-2026-00001/offers', offerKey, {}))
      .willRespondWith({ status: 201, headers: jsonResponse, body: offerBody });
    await pact.executeTest(async server => {
      const outcome = await withServer(server.url, () => createOffer('COT-2026-00001', offerKey));
      assert.ok(outcome.kind === 'ok' && outcome.value.offerId === offerId && outcome.value.premium === '77760.0000');
    });
  });

  test('is sent back to consent without a current authorization', async () => {
    pact.given('a customer without a current consent').uponReceiving('a definitive offer request without current consent')
      .withRequest(post('/api/v1/quotes/COT-2026-00001/offers', offerKey, {}))
      .willRespondWith({ status: 403, headers: jsonResponse, body: { error: MatchersV3.equal('consent_required'), traceId } });
    await pact.executeTest(async server => assert.deepEqual(await withServer(server.url, () => createOffer('COT-2026-00001', offerKey)), { kind: 'consentRequired' }));
  });

  test('records the acceptance as pending issuance', async () => {
    pact.given('a customer with a current definitive offer').uponReceiving('an offer acceptance')
      .withRequest(post(`/api/v1/offers/${offerId}/accept`, offerKey, {}))
      .willRespondWith({ status: 202, headers: jsonResponse, body: {
        acceptanceId: MatchersV3.equal(acceptanceId), offerId: MatchersV3.equal(offerId), eventId: MatchersV3.uuid('40000000-0000-4000-8000-000000000004'),
        acceptedAt: instant('2026-10-15T00:01:00.000Z'), status: MatchersV3.equal('pending_issuance'), synthetic: MatchersV3.equal(true), traceId } });
    await pact.executeTest(async server => {
      const outcome = await withServer(server.url, () => acceptOffer(offerId, offerKey));
      assert.ok(outcome.kind === 'ok' && outcome.value.acceptanceId === acceptanceId);
    });
  });

  test('reports an expired offer', async () => {
    pact.given('the definitive offer expired').uponReceiving('an acceptance of an expired offer')
      .withRequest(post(`/api/v1/offers/${offerId}/accept`, offerKey, {}))
      .willRespondWith({ status: 409, headers: jsonResponse, body: { error: MatchersV3.equal('expired'), traceId } });
    await pact.executeTest(async server => assert.deepEqual(await withServer(server.url, () => acceptOffer(offerId, offerKey)), { kind: 'rejected', code: 'expired' }));
  });

  test('waits while the accepted offer is not imported yet', async () => {
    pact.given('the accepted offer is not imported yet').uponReceiving('a policy lookup before import')
      .withRequest({ method: 'GET', path: `/api/v1/policies/by-acceptance/${acceptanceId}/policy` })
      .willRespondWith({ status: 404, headers: jsonResponse, body: { error: MatchersV3.equal('not_found'), traceId } });
    await pact.executeTest(async server => assert.deepEqual(await withServer(server.url, () => policyForAcceptance(acceptance)), { kind: 'notFound' }));
  });

  test('receives the policy document to review', async () => {
    pact.given('the accepted offer was imported').uponReceiving('a policy lookup after import')
      .withRequest({ method: 'GET', path: `/api/v1/policies/by-acceptance/${acceptanceId}/policy` })
      .willRespondWith({ status: 200, headers: jsonResponse, body: policyBody('pending') });
    await pact.executeTest(async server => {
      const outcome = await withServer(server.url, () => policyForAcceptance(acceptance));
      assert.ok(outcome.kind === 'ok' && outcome.value.status === 'pending' && outcome.value.documentHash === documentHash);
    });
  });

  test('confirms a charge before signing the reviewed document', async () => {
    pact.given('the accepted offer was imported').uponReceiving('a charge for the reviewed document')
      .withRequest(post(`/api/v1/policies/${policyId}/charge`, offerKey, { documentHash }))
      .willRespondWith({ status: 200, headers: jsonResponse, body: { ...policyBody('charged'),
        payment: { status: MatchersV3.equal('confirmed'), reference: MatchersV3.regex('^MOCK-[0-9a-f-]{36}$',
          'MOCK-60000000-0000-4000-8000-000000000006') } } });
    await pact.executeTest(async server => {
      const outcome = await withServer(server.url, () => chargePolicy({ policyId, documentHash }, offerKey));
      assert.ok(outcome.kind === 'ok' && outcome.value.status === 'charged');
    });
  });

  test('issues the reviewed document', async () => {
    pact.given('the accepted offer was imported').uponReceiving('an issuance of the reviewed document')
      .withRequest(post(`/api/v1/policies/${policyId}/issue`, offerKey, { documentHash, challengeId, code }))
      .willRespondWith({ status: 200, headers: jsonResponse, body: policyBody('issued') });
    await pact.executeTest(async server => {
      const outcome = await withServer(server.url, () => issuePolicy({ policyId, documentHash }, offerKey, challengeId, code));
      assert.ok(outcome.kind === 'ok' && outcome.value.status === 'issued');
    });
  });

  test('reports an uncertain issuance as unavailable', async () => {
    pact.given('the policy service is down').uponReceiving('an issuance while Policy is unavailable')
      .withRequest(post(`/api/v1/policies/${policyId}/issue`, offerKey, { documentHash, challengeId, code }))
      .willRespondWith({ status: 503 });
    await pact.executeTest(async server => assert.equal((await withServer(server.url, () => issuePolicy({ policyId, documentHash }, offerKey, challengeId, code))).kind, 'unavailable'));
  });
  test('requests a code for the reviewed document', async () => {
    pact.given('the accepted offer was imported').uponReceiving('a signature challenge for the reviewed document')
      .withRequest({ method: 'POST', path: `/api/v1/policies/${policyId}/signature-challenges`,
        headers: { 'content-type': 'application/json' }, body: { documentHash, accepted: true } })
      .willRespondWith({ status: 200, headers: jsonResponse, body: { ...policyBody('pending'),
        challenge: { challengeId: MatchersV3.equal(challengeId), expiresAt: instant('2026-10-15T00:05:00.000Z'),
          demoCode: MatchersV3.equal(code) } } });
    await pact.executeTest(async server => {
      const outcome = await withServer(server.url, () => beginSignatureChallenge({ policyId, documentHash }));
      assert.ok(outcome.kind === 'ok' && outcome.value.challengeId === challengeId);
    });
  });
});
