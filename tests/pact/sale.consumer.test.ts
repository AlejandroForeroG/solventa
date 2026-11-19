import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { PactV3, MatchersV3 } from '@pact-foundation/pact';
import { grantSaleAuthorization, listSaleAuthorizations, prepareAdvisorOffer, revokeSaleAuthorization } from '../../apps/web/src/sale/api';
import { saleIds } from './support/sale';
import { assertMatchesCommitted, pactOutputDir, providerName } from './support/pact-files';

const consumer = 'solventa-sale-web', dir = pactOutputDir(), pact = new PactV3({ consumer, provider: providerName, dir, logLevel: 'error' });
after(() => assertMatchesCommitted(dir, `${consumer}-${providerName}.json`));
const trace = MatchersV3.uuid('50000000-0000-4000-8000-000000000001');
const authorization = { authorizationId: saleIds.authorizationId, advisorReference: saleIds.advisorReference, operation: 'advisor-sale:prepare',
  grantedAt: MatchersV3.iso8601DateTimeWithMillis('2026-11-11T12:00:00.000Z'), expiresAt: MatchersV3.iso8601DateTimeWithMillis('2026-11-12T12:00:00.000Z'), revokedAt: null, status: 'active' };
const json = { 'Content-Type': 'application/json' };

async function withServer<T>(run: () => Promise<T>, url: string): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => original(typeof input === 'string' && input.startsWith('/') ? url + input : input, init);
  try { return await run(); } finally { globalThis.fetch = original; }
}

test('a customer authorizes a known advisor and the authorization names the advisor and the bounded time', async () => {
  pact.given('a customer who can authorize an advisor').uponReceiving('an advisor sale authorization')
    .withRequest({ method: 'POST', path: '/api/v1/me/advisor-sale-authorizations', headers: { 'content-type': 'application/json' }, body: { advisorReference: saleIds.advisorReference, validityDays: 1 } })
    .willRespondWith({ status: 201, headers: json, body: { ...authorization, traceId: trace } });
  await pact.executeTest(async server => {
    const result = await withServer(() => grantSaleAuthorization({ advisorReference: saleIds.advisorReference, validityDays: 1 }), server.url);
    assert.equal(result.kind, 'ok');
    assert.equal(result.kind === 'ok' && result.value.authorizationId, saleIds.authorizationId);
  });
});

test('an unknown advisor reference is an opaque not found and creates nothing', async () => {
  pact.given('a customer who can authorize an advisor').uponReceiving('an advisor sale authorization for an unknown reference')
    .withRequest({ method: 'POST', path: '/api/v1/me/advisor-sale-authorizations', headers: { 'content-type': 'application/json' }, body: { advisorReference: '03000000-0000-4000-8000-0000000000ff', validityDays: 1 } })
    .willRespondWith({ status: 404, headers: json, body: { error: 'advisor_not_found', traceId: trace } });
  await pact.executeTest(async server => {
    assert.equal((await withServer(() => grantSaleAuthorization({ advisorReference: '03000000-0000-4000-8000-0000000000ff', validityDays: 1 }), server.url)).kind, 'notFound');
  });
});

test('a customer lists the authorizations they gave', async () => {
  pact.given('a customer with an active advisor authorization').uponReceiving('a list of advisor sale authorizations')
    .withRequest({ method: 'GET', path: '/api/v1/me/advisor-sale-authorizations' })
    .willRespondWith({ status: 200, headers: json, body: { items: [authorization], traceId: trace } });
  await pact.executeTest(async server => {
    const result = await withServer(() => listSaleAuthorizations(), server.url);
    assert.deepEqual(result.kind === 'ok' ? result.value.map(item => item.status) : null, ['active']);
  });
});

test('a customer revokes an authorization and the answer is the revoked record', async () => {
  pact.given('a customer with an active advisor authorization').uponReceiving('a revocation of an advisor sale authorization')
    .withRequest({ method: 'POST', path: `/api/v1/me/advisor-sale-authorizations/${saleIds.authorizationId}/revoke` })
    .willRespondWith({ status: 200, headers: json, body: { ...authorization, revokedAt: MatchersV3.iso8601DateTimeWithMillis('2026-11-11T13:00:00.000Z'), status: 'revoked', traceId: trace } });
  await pact.executeTest(async server => {
    const result = await withServer(() => revokeSaleAuthorization(saleIds.authorizationId), server.url);
    assert.equal(result.kind === 'ok' && result.value.status, 'revoked');
  });
});

const request = { authorizationId: saleIds.authorizationId, customer: { fullName: 'Laura Catalina Restrepo Ochoa', documentType: 'CC', documentNumber: '1020884771', birthDate: '1992-03-14', city: 'Bogotá D.C.' },
  credit: { partnerCreditId: 'CRE-88-2026', amount: 320000000, termMonths: 180 } };
for (const mode of ['ready', 'forbidden', 'consent_required', 'unavailable'] as const) {
  test(`an advisor prepares the offer for an authorized customer: ${mode}`, async () => {
    const status = mode === 'ready' ? 201 : mode === 'unavailable' ? 503 : 403;
    pact.given(`an advisor sale ${mode}`).uponReceiving(`an advisor offer preparation with ${mode} access`)
      .withRequest({ method: 'POST', path: '/api/v1/advisor/offers', headers: { 'content-type': 'application/json', 'idempotency-key': 'sale-1' }, body: { ...request, product: 'vida_hipotecario' } })
      .willRespondWith({ status, headers: json, body: status === 201 ? { offerId: saleIds.offerId, quoteId: 'COT-2026-00001', status: 'definitive', contractable: true, premium: '77760.0000', currency: 'COP',
        coverage: { kind: 'mortgage_life', sumInsured: '320000000.0000' }, validity: { effectiveFrom: MatchersV3.iso8601DateTimeWithMillis('2026-11-12T00:00:00.000Z'), effectiveUntil: MatchersV3.iso8601DateTimeWithMillis('2027-11-12T00:00:00.000Z'),
          expiresAt: MatchersV3.iso8601DateTimeWithMillis('2026-11-12T12:00:00.000Z') },
        signals: MatchersV3.eachLike({ scope: 'income_obligations_12m', quality: 'live', degraded: false, confidence: 100, capturedAt: MatchersV3.iso8601DateTimeWithMillis('2026-11-11T12:00:00.000Z') }, 4),
        explanation: { ratingVersion: 'academic-mortgage-1', underwritingVersion: 'academic-mortgage-1', baseRatePpm: 1000, adjustmentPpm: 0 }, synthetic: true, traceId: trace }
        : { error: mode === 'unavailable' ? 'access_unavailable' : mode, traceId: trace } });
    await pact.executeTest(async server => {
      const result = await withServer(() => prepareAdvisorOffer(request, 'sale-1'), server.url);
      assert.equal(result.kind, mode === 'ready' ? 'ok' : mode === 'forbidden' ? 'forbidden' : mode === 'consent_required' ? 'consentRequired' : 'unavailable');
    });
  });
}
