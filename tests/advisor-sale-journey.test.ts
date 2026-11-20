import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import worker from '../apps/web/worker/index';
import { createHttp as createIdentityHttp } from '../backend/identity-consent-ecosystem/src/adapters/inbound/http';
import { authorizeApiAccess } from '../backend/identity-consent-ecosystem/src/adapters/inbound/api-access-http';
import { HmacIntegrity } from '../backend/identity-consent-ecosystem/src/adapters/outbound/hmac-integrity';
import { ApiAccess } from '../backend/identity-consent-ecosystem/src/application/api-access';
import { Consents } from '../backend/identity-consent-ecosystem/src/application/consents';
import { AdvisorSaleAuthorizations } from '../backend/identity-consent-ecosystem/src/application/advisor-sale-authorizations';
import { authorizeAdvisorSaleAccess } from '../backend/identity-consent-ecosystem/src/application/advisor-sale-access';
import { authorizeFinancialAccess } from '../backend/identity-consent-ecosystem/src/application/financial-access';
import { createHttp as createAcquisitionHttp } from '../backend/acquisition-risk/src/adapters/inbound/http';
import { HmacOfferIntegrity } from '../backend/acquisition-risk/src/adapters/outbound/hmac-offer-integrity';
import { HmacProtector } from '../backend/acquisition-risk/src/adapters/outbound/hmac-protector';
import { IdentityAdvisorSaleAccess } from '../backend/acquisition-risk/src/adapters/outbound/identity-advisor-sale-access';
import { MockFlightSchedule, MockRiskSignals } from '../backend/acquisition-risk/src/adapters/outbound/mock-risk-signals';
import { AdvisorOffers } from '../backend/acquisition-risk/src/application/advisor-offers';
import { CreateQuote } from '../backend/acquisition-risk/src/application/create-quote';
import { EstimateQuote } from '../backend/acquisition-risk/src/application/estimate-quote';
import { OfferService } from '../backend/acquisition-risk/src/application/offer-service';
import { ReadSignal } from '../backend/acquisition-risk/src/application/read-signal';
import { offerRequestIdentity } from '../backend/acquisition-risk/src/domain/offer';
import { SEAL_KEY, MemoryConsents, ANA, LUIS, clock } from './support/consent-fakes';
import { MemoryStore } from './support/quote-fakes';
import { MemoryAdvisorSaleAuthorizations } from './support/advisor-sale-fakes';
import { JourneyOffers, NoSnapshots } from './support/journey-offers';
import { contractSchema } from './support/openapi-schemas';

// The advisor's browser calls the real gateway, which routes to the real Identity and Acquisition HTTP adapters and use cases.
// In memory: SQL stores and the WorkOS web sessions; mock: signal providers. Nothing here runs SQL or workerd.
console.log = () => {};
const ORIGIN = 'https://solventa.test';
const ADVISOR = { clientId: randomUUID(), subjectToken: randomUUID() };
const OTHER_ADVISOR = { clientId: randomUUID(), subjectToken: randomUUID() };
const advisorReferences = { advisor: randomUUID(), other: randomUUID() };
const sessions = new Map([['ana-session', ANA], ['luis-session', LUIS], ['advisor-session', ADVISOR], ['other-advisor-session', OTHER_ADVISOR]]);
const references = new Map([['advisor-session', advisorReferences.advisor], ['other-advisor-session', advisorReferences.other]]);
const contract = {
  offer: contractSchema('partner-offers', 'PartnerOffer'), invalid: contractSchema('partner-offers', 'ValidationError'), offerError: contractSchema('advisor-offers', 'AccessError'),
  authorization: contractSchema('advisor-sale-authorizations', 'Authorization'), list: contractSchema('advisor-sale-authorizations', 'AuthorizationList'), customerError: contractSchema('advisor-sale-authorizations', 'Error')
};
// Every response the journey sees must match the committed OpenAPI contract.
const conforms = (check: ReturnType<typeof contractSchema>, body: unknown) => { const result = check(body); assert.equal(result.valid, true, result.errors); };
const quote = { product: 'vida_hipotecario', customer: { fullName: 'Ana Prueba', documentType: 'CC', documentNumber: '1000000001', birthDate: '1990-05-17', city: 'Bogota' },
  credit: { partnerCreditId: 'CR-1', amount: 200000000, termMonths: 120 } };

async function world(options: { identityDown?: () => boolean } = {}) {
  const time = clock('2026-11-09T12:00:00Z');
  const consentStore = new MemoryConsents();
  const consents = new Consents({ store: consentStore, platform: time, integrity: new HmacIntegrity(SEAL_KEY) });
  const authorizationStore = new MemoryAdvisorSaleAuthorizations(new Map([[advisorReferences.advisor, ADVISOR.clientId], [advisorReferences.other, OTHER_ADVISOR.clientId]]), time.now);
  const denials: { operation: string; channel: string; cause: string }[] = [];
  const advisors = {
    find: async (_principal: unknown, identity: { sessionReference: string }) => {
      const reference = references.get(identity.sessionReference);
      return reference ? { reference, expiresAt: new Date(Date.now() + 4000).toISOString() } : null;
    },
    eligible: async () => null
  };
  const access = new ApiAccess({ find: async () => null }, { find: async identity => sessions.get(identity.sessionReference) ?? null } as never, undefined, undefined, undefined, advisors);
  const authorize = (input: unknown) => authorizeApiAccess({
    application: access, security: { deny: async denial => { denials.push(denial); } },
    partner: { authenticate: async () => null },
    web: { authenticate: async cookie => sessions.has(cookie) ? { identity: { emailVerified: true, providerSubject: 'user_' + cookie, sessionReference: cookie } as never } : null, allowedOrigins: [ORIGIN] }
  }, input);
  const identityHttp = createIdentityHttp({ authentication: {} as never, authorizeApiAccess: authorize, consents,
    advisorSaleAuthorizations: new AdvisorSaleAuthorizations({ store: authorizationStore, now: time.now }) });
  const identityRpc = {
    authorizeAdvisorSaleV1: async (input: unknown) => {
      if (options.identityDown?.()) throw Error('identity unavailable');
      return authorizeAdvisorSaleAccess({ authorize, advisors: advisors as never, authorizations: authorizationStore, verifyConsents: input => consents.verifyScopes(input),
        security: { deny: async denial => { denials.push(denial); } } as never }, input);
    }
  };
  const quoteStore = new MemoryStore();
  const protector = new HmacProtector('synthetic-journey-key-'.padEnd(40, 'x'));
  const quotes = new CreateQuote({ access: { authorize: async () => { throw Error('advisors never create their own quote here'); } }, store: quoteStore, clock: time, protector });
  const offerStore = new JourneyOffers(quoteStore);
  const offers = new OfferService({ store: offerStore, integrity: new HmacOfferIntegrity('synthetic-journey-financial-key-'.padEnd(40, 'x')), flights: new MockFlightSchedule(time.now),
    signals: new ReadSignal({ guard: { verify: async () => ({ allowed: false, reason: 'unavailable' }) }, provider: new MockRiskSignals(time.now), snapshots: new NoSnapshots(), clock: time,
      timer: { after: () => new Promise<void>(() => {}) }, trace: { record: () => {} } }),
    clock: time, environment: 'local', enabled: true });
  const acquisitionHttp = createAcquisitionHttp({ quotes, estimates: new EstimateQuote(),
    advisorOffers: new AdvisorOffers({ access: new IdentityAdvisorSaleAccess(identityRpc, 40), quotes, offers, protector }),
    offers: { offers, authorizeFinancialAccess: input => authorizeFinancialAccess({ authorize, verifyConsents: input => consents.verifyScopes(input) }, input), denyResourceAccess: async () => ({ recorded: true }) } });
  const env = { APP_ENV: 'local', IDENTITY: { fetch: (request: Request) => identityHttp.fetch(request, { APP_ENV: 'local' } as never) },
    ACQUISITION: { fetch: (request: Request) => acquisitionHttp.fetch(request, { APP_ENV: 'local' } as never) }, POLICY: { fetch: async () => assert.fail('unused') }, ASSETS: { fetch: async () => new Response('asset') } } as never;
  const gateway = (request: Request) => worker.fetch(request, env);
  const browser = async (session: string | null, path: string, body?: unknown, key?: string, extra: Record<string, string> = {}) => {
    const response = await gateway(new Request(ORIGIN + path, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(session ? { cookie: `solventa-session=${session}` } : {}), origin: ORIGIN, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}), ...extra } }));
    const payload = await response.json() as Record<string, any>;
    if (path.startsWith('/api/v1/me/advisor-sale-authorizations')) conforms(response.status >= 400 ? contract.customerError : payload.items ? contract.list : contract.authorization, payload);
    if (path === '/api/v1/advisor/offers') conforms(response.status === 200 || response.status === 201 ? contract.offer : payload.error === 'validation_error' ? contract.invalid : contract.offerError, payload);
    return { status: response.status, headers: response.headers, body: payload };
  };
  const authorizeAdvisor = async (session: string, advisorReference: string, validityDays?: number) => {
    const response = await browser(session, '/api/v1/me/advisor-sale-authorizations', { advisorReference, ...(validityDays ? { validityDays } : {}) });
    assert.equal(response.status, 201);
    return response.body.authorizationId as string;
  };
  const prepare = (session: string | null, authorizationId: unknown, key: string | null, body: Record<string, unknown> = quote) =>
    browser(session, '/api/v1/advisor/offers', { authorizationId, ...body }, key ?? undefined);
  const consent = async (session: string) => assert.equal((await browser(session, '/api/v1/consents', { textVersion: 2, locale: 'es-CO' }, 'consent-' + session)).status, 201);
  return { gateway, browser, authorizeAdvisor, prepare, consent, consentStore, quoteStore, offerStore, denials, time, authorizationStore };
}

test('an authorized advisor prepares the offer for the customer: it belongs to the customer, names the advisor channel and follows the capture schema', async () => {
  const w = await world();
  await w.consent('ana-session');
  const authorizationId = await w.authorizeAdvisor('ana-session', advisorReferences.advisor);
  const result = await w.prepare('advisor-session', authorizationId, 'sale-1');
  assert.equal(result.status, 201);
  assert.equal(result.body.status, 'definitive');
  assert.equal(result.body.contractable, true);
  assert.match(result.body.premium, /^\d+\.\d{4}$/);
  const text = JSON.stringify(result.body);
  for (const hidden of [ANA.clientId, ANA.subjectToken, ADVISOR.clientId, ADVISOR.subjectToken, '8000000', 'monthlyIncome']) assert.equal(text.includes(hidden), false, hidden);
  const stored = [...w.offerStore.captures.values()][0];
  assert.deepEqual(stored.channel, { kind: 'advisor', advisorReference: advisorReferences.advisor, authorizationId });
  assert.equal(new Ajv({ allErrors: true }).compile(JSON.parse(readFileSync('packages/contracts/schemas/decision-capture.v1.json', 'utf8')))(stored), true);
  assert.deepEqual(stored.consent, { status: 'verified', id: 'CNS-2026-00001', version: 2 });
  assert.equal(w.quoteStore.saved[0].actor.kind === 'user' && w.quoteStore.saved[0].actor.clientId, ANA.clientId, 'the quote belongs to the customer, never to the advisor');
  assert.equal([...w.offerStore.offers.values()][0].terms.clientId, ANA.clientId);
});

test('a foreign advisor, an invented authorization, a customer session and no session never reach a price, and denials are recorded', async () => {
  const w = await world();
  await w.consent('ana-session');
  await w.consent('luis-session');
  const authorizationId = await w.authorizeAdvisor('ana-session', advisorReferences.advisor);
  const foreign = await w.prepare('other-advisor-session', authorizationId, 'k1');
  assert.deepEqual([foreign.status, foreign.body.error], [403, 'forbidden'], "another advisor cannot use Ana's authorization");
  const invented = await w.prepare('advisor-session', randomUUID(), 'k2');
  assert.deepEqual([invented.status, invented.body.error], [403, 'forbidden']);
  assert.deepEqual([foreign.status, foreign.body.error], [invented.status, invented.body.error], 'a foreign and an unknown authorization look the same');
  const customerSession = await w.prepare('luis-session', authorizationId, 'k3');
  assert.deepEqual([customerSession.status, customerSession.body.error], [403, 'forbidden'], 'a customer session is not an advisor permission');
  const anonymous = await w.prepare(null, authorizationId, 'k4');
  assert.deepEqual([anonymous.status, anonymous.body.error], [401, 'unauthorized']);
  const named = await w.prepare('advisor-session', authorizationId, 'k5', { ...quote, clientId: LUIS.clientId, subjectToken: LUIS.subjectToken });
  assert.equal(named.status, 400, 'a customer identifier in the body is rejected, never obeyed');
  assert.equal(w.quoteStore.saved.length, 0, 'no denied request created a quote');
  assert.equal(w.offerStore.offers.size, 0);
  assert.equal(w.denials.filter(denial => denial.operation === 'advisor-sale:prepare').length, 2);
});

test('a customer cannot authorize someone who is not a current advisor, and an advisor is not authorized by a bearer token', async () => {
  const w = await world();
  assert.equal((await w.browser('ana-session', '/api/v1/me/advisor-sale-authorizations', { advisorReference: randomUUID() })).status, 404);
  assert.equal((await w.browser('advisor-session', '/api/v1/me/advisor-sale-authorizations', { advisorReference: advisorReferences.advisor })).status, 404, 'an advisor cannot authorize themselves');
  const bearer = await w.browser(null, '/api/v1/advisor/offers', { authorizationId: randomUUID(), ...quote }, 'k1', { authorization: 'Bearer aaaa.bbbb.cccc' });
  assert.equal(bearer.status, 400);
  assert.equal(w.authorizationStore.rows.length, 0);
});

test('revoking the authorization or the consent stops the next offer, and a retry of a finished sale is no exception', async () => {
  const w = await world();
  await w.consent('ana-session');
  const authorizationId = await w.authorizeAdvisor('ana-session', advisorReferences.advisor);
  assert.equal((await w.prepare('advisor-session', authorizationId, 'sale-1')).status, 201);
  const revoked = await w.browser('ana-session', `/api/v1/me/advisor-sale-authorizations/${authorizationId}/revoke`, {});
  assert.equal(revoked.body.status, 'revoked');
  const after = await w.prepare('advisor-session', authorizationId, 'sale-2');
  assert.deepEqual([after.status, after.body.error], [403, 'forbidden']);
  assert.equal((await w.prepare('advisor-session', authorizationId, 'sale-1')).status, 403, 'a revoked authorization also blocks replays');
  const fresh = await w.authorizeAdvisor('ana-session', advisorReferences.advisor);
  assert.equal((await w.prepare('advisor-session', fresh, 'sale-3')).status, 201);
  assert.equal((await w.browser('ana-session', `/api/v1/consents/${w.consentStore.consents[0].consentCode}/revoke`, {})).status, 200);
  const afterConsent = await w.prepare('advisor-session', fresh, 'sale-4');
  assert.deepEqual([afterConsent.status, afterConsent.body.error], [403, 'consent_required']);
  assert.equal(w.quoteStore.saved.length, 2, 'blocked requests wrote nothing');
});

test('without the customer consent, or with an expired authorization, the advisor gets nothing', async () => {
  const w = await world();
  const authorizationId = await w.authorizeAdvisor('ana-session', advisorReferences.advisor, 1);
  const noConsent = await w.prepare('advisor-session', authorizationId, 'k1');
  assert.deepEqual([noConsent.status, noConsent.body.error], [403, 'consent_required'], 'an authorization to the advisor is not consent to use the data');
  await w.consent('ana-session');
  assert.equal((await w.prepare('advisor-session', authorizationId, 'k2')).status, 201);
  w.time.advance(2 * 24 * 60);
  const expired = await w.prepare('advisor-session', authorizationId, 'k3');
  assert.deepEqual([expired.status, expired.body.error], [403, 'forbidden']);
});

test('an unavailable Identity blocks the sale with a 503 and writes nothing, and recovery needs no new key', async () => {
  let down = true;
  const w = await world({ identityDown: () => down });
  await w.consent('ana-session');
  const authorizationId = await w.authorizeAdvisor('ana-session', advisorReferences.advisor);
  const outage = await w.prepare('advisor-session', authorizationId, 'sale-1');
  assert.deepEqual([outage.status, outage.body.error], [503, 'access_unavailable']);
  assert.equal(w.quoteStore.saved.length, 0);
  down = false;
  assert.equal((await w.prepare('advisor-session', authorizationId, 'sale-1')).status, 201);
});

test('retrying a sale replays the same offer without a second quote, a changed sale conflicts, and a key never crosses authorizations', async () => {
  const w = await world();
  await w.consent('ana-session');
  await w.consent('luis-session');
  const first = await w.authorizeAdvisor('ana-session', advisorReferences.advisor);
  const second = await w.authorizeAdvisor('ana-session', advisorReferences.advisor);
  const luis = await w.authorizeAdvisor('luis-session', advisorReferences.advisor);
  const original = await w.prepare('advisor-session', first, 'sale-1');
  const retry = await w.prepare('advisor-session', first, 'sale-1');
  assert.deepEqual([original.status, retry.status], [201, 200]);
  assert.equal(retry.body.offerId, original.body.offerId);
  assert.equal(retry.body.premium, original.body.premium);
  assert.equal(w.quoteStore.saved.length, 1);
  assert.equal(w.offerStore.offers.size, 1);
  const changed = await w.prepare('advisor-session', first, 'sale-1', { ...quote, credit: { ...quote.credit, amount: 300000000 } });
  assert.deepEqual([changed.status, changed.body.error], [409, 'idempotency_key_reused']);
  const otherAuthorization = await w.prepare('advisor-session', second, 'sale-1');
  assert.equal(otherAuthorization.status, 201, 'a key under another authorization is another sale, never a replay of the first');
  assert.notEqual(otherAuthorization.body.offerId, original.body.offerId);
  const otherCustomer = await w.prepare('advisor-session', luis, 'sale-1');
  assert.equal(otherCustomer.status, 201);
  assert.notEqual(otherCustomer.body.offerId, original.body.offerId);
  const luisAgain = await w.prepare('advisor-session', luis, 'sale-1');
  assert.deepEqual([luisAgain.status, luisAgain.body.offerId], [200, otherCustomer.body.offerId], "each customer's sale replays its own offer");
  assert.equal(w.offerStore.offers.size, 3);
});

test('the request is validated before it prices: bad body, missing key and unknown fields never create anything', async () => {
  const w = await world();
  await w.consent('ana-session');
  const authorizationId = await w.authorizeAdvisor('ana-session', advisorReferences.advisor);
  const cases: [unknown, string | null, Record<string, unknown>?][] = [
    ['not-a-uuid', 'k'], [undefined, 'k'], [authorizationId, null], [authorizationId, 'k', { ...quote, credit: { ...quote.credit, amount: -1 } }],
    [authorizationId, 'k', { ...quote, customer: { ...quote.customer, birthDate: '2015-01-01' } }]];
  for (const [id, key, body] of cases) assert.equal((await w.prepare('advisor-session', id, key, body)).status, 400);
  assert.equal(w.quoteStore.saved.length, 0);
  assert.equal(w.offerStore.offers.size, 0);
  assert.equal(offerRequestIdentity('vida_hipotecario', 'COT-2026-00001').length > 0, true);
});
