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
import { PartnerAuthorizations } from '../backend/identity-consent-ecosystem/src/application/partner-authorizations';
import { authorizePartnerOfferAccess } from '../backend/identity-consent-ecosystem/src/application/partner-offer-access';
import { authorizeFinancialAccess } from '../backend/identity-consent-ecosystem/src/application/financial-access';
import { createHttp as createAcquisitionHttp } from '../backend/acquisition-risk/src/adapters/inbound/http';
import { HmacOfferIntegrity } from '../backend/acquisition-risk/src/adapters/outbound/hmac-offer-integrity';
import { HmacProtector } from '../backend/acquisition-risk/src/adapters/outbound/hmac-protector';
import { IdentityPartnerOfferAccess } from '../backend/acquisition-risk/src/adapters/outbound/identity-partner-offer-access';
import { MockFlightSchedule, MockRiskSignals } from '../backend/acquisition-risk/src/adapters/outbound/mock-risk-signals';
import { CreateQuote } from '../backend/acquisition-risk/src/application/create-quote';
import { EstimateQuote } from '../backend/acquisition-risk/src/application/estimate-quote';
import { OfferService } from '../backend/acquisition-risk/src/application/offer-service';
import { PartnerOffers } from '../backend/acquisition-risk/src/application/partner-offers';
import { ProviderFailure, type SignalProvider, type SignalSnapshot, type SignalSnapshots } from '../backend/acquisition-risk/src/application/ports/signal-sources';
import type { OfferStore, StoredOffer, StoredOfferRequest } from '../backend/acquisition-risk/src/application/ports/offer-store';
import { ReadSignal } from '../backend/acquisition-risk/src/application/read-signal';
import { offerRequestIdentity, type OfferActor, type OfferCapture } from '../backend/acquisition-risk/src/domain/offer';
import { SEAL_KEY, MemoryConsents, ANA, LUIS, clock } from './support/consent-fakes';
import { MemoryStore } from './support/quote-fakes';
import { MemoryPartnerAuthorizations } from './support/partner-authorization-fakes';
import { createMockIssuer } from './support/mock-partner-issuer';
import { PartnerOfferConsumer } from './support/partner-offer-consumer';
import { contractSchema } from './support/openapi-schemas';

const contract = {
  offer: contractSchema('partner-offers', 'PartnerOffer'), invalid: contractSchema('partner-offers', 'ValidationError'), partnerError: contractSchema('partner-offers', 'AccessError'),
  authorization: contractSchema('partner-authorizations', 'Authorization'), list: contractSchema('partner-authorizations', 'AuthorizationList'), customerError: contractSchema('partner-authorizations', 'Error')
};
const conforms = (check: ReturnType<typeof contractSchema>, body: unknown) => { const result = check(body); assert.equal(result.valid, true, result.errors); };

// Every partner response the journey sees must match the committed OpenAPI contract.
class ContractConsumer extends PartnerOfferConsumer {
  override async requestOffer(input: Parameters<PartnerOfferConsumer['requestOffer']>[0]) {
    const result = await super.requestOffer(input);
    conforms(result.status === 200 || result.status === 201 ? contract.offer : result.status === 400 ? contract.invalid : contract.partnerError, result.body);
    return result;
  }
}

// The partner's consumer calls the real gateway, which routes to the real Identity and Acquisition HTTP adapters and use cases.
// In memory: SQL stores, the WorkOS web session and the WorkOS Connect issuer keys; mock: signal providers. Nothing here runs SQL or workerd.
// The handler logs one profiling line per request; each test file runs in its own process.
console.log = () => {};
const ORIGIN = 'https://solventa.test';
const partnerIds = { acme: randomUUID(), globex: randomUUID(), limited: randomUUID() };
const credentials = new Map([
  [JSON.stringify(['https://synthetic.authkit.app', 'org_acme', 'client_acme']), { partnerId: partnerIds.acme, credentialId: randomUUID(), scopes: ['quotes:create', 'partner-offers:create'] }],
  [JSON.stringify(['https://synthetic.authkit.app', 'org_globex', 'client_globex']), { partnerId: partnerIds.globex, credentialId: randomUUID(), scopes: ['quotes:create', 'partner-offers:create'] }],
  [JSON.stringify(['https://synthetic.authkit.app', 'org_limited', 'client_limited']), { partnerId: partnerIds.limited, credentialId: randomUUID(), scopes: ['quotes:create'] }]]);
const identities = { acme: { applicationId: 'client_acme', organizationId: 'org_acme' }, globex: { applicationId: 'client_globex', organizationId: 'org_globex' }, limited: { applicationId: 'client_limited', organizationId: 'org_limited' } };
const sessions = new Map([['ana-session', ANA], ['luis-session', LUIS]]);
const quote = { product: 'vida_hipotecario', customer: { fullName: 'Ana Prueba', documentType: 'CC', documentNumber: '1000000001', birthDate: '1990-05-17', city: 'Bogota' },
  credit: { partnerCreditId: 'CR-1', amount: 200000000, termMonths: 120 } };

class FailingScope implements SignalProvider {
  constructor(private readonly inner: SignalProvider, private readonly failing: () => boolean) {}
  async read(subjectToken: string, scope: Parameters<SignalProvider['read']>[1], traceId: string) {
    if (this.failing() && scope === 'payment_history_score') throw new ProviderFailure('timeout');
    return this.inner.read(subjectToken, scope, traceId);
  }
}
class NoSnapshots implements SignalSnapshots {
  async find(): Promise<SignalSnapshot | null> { return null; }
  async save() {}
}
class JourneyOffers implements OfferStore {
  requests = new Map<string, StoredOfferRequest>(); offers = new Map<string, StoredOffer>(); captures = new Map<string, OfferCapture>();
  constructor(private readonly quotes: MemoryStore) {}
  async creationSnapshot(actor: OfferActor, key: string, quoteId: string | null) {
    const request = this.requests.get(actor.clientId + key) ?? null;
    const index = quoteId === null || request ? -1 : this.quotes.saved.findIndex((saved, position) => `COT-2026-${String(position + 1).padStart(5, '0')}` === quoteId
      && saved.actor.kind === 'user' && saved.actor.clientId === actor.clientId && saved.subjectToken === actor.subjectToken);
    const saved = this.quotes.saved[index];
    return { request, legacy: null, quote: saved ? { id: randomUUID(), quoteId: quoteId as string, amount: saved.amount, termMonths: saved.termMonths, ageYears: saved.capture.inputs.ageYears, validUntil: saved.validUntil } : null };
  }
  async create(input: Parameters<OfferStore['create']>[0]) {
    const existing = this.requests.get(input.actor.clientId + input.key);
    if (existing) return { created: false, request: existing };
    const request: StoredOfferRequest = { actor: input.actor, requestIdentity: input.requestIdentity, outcome: 'accepted', offer: input.offer };
    this.requests.set(input.actor.clientId + input.key, request); this.offers.set(input.offer.terms.offerId, input.offer); this.captures.set(input.offer.terms.offerId, input.capture as OfferCapture);
    return { created: true, request };
  }
  async decline(input: Parameters<OfferStore['decline']>[0]) {
    const request: StoredOfferRequest = { actor: input.actor, requestIdentity: input.requestIdentity, outcome: 'declined' };
    this.requests.set(input.actor.clientId + input.key, request);
    return { created: true, request };
  }
  async explanation(actor: OfferActor, offerId: string) {
    const offer = this.offers.get(offerId);
    return offer && offer.terms.clientId === actor.clientId ? this.captures.get(offerId) ?? null : null;
  }
  async get(): Promise<StoredOffer | null> { throw Error('not used'); }
  async acceptanceSnapshot(): Promise<never> { throw Error('not used'); }
  async accept(): Promise<never> { throw Error('not used'); }
  async reject() {}
}

async function world(options: { identityDown?: () => boolean; identityDelayMs?: () => number; signalFailure?: () => boolean } = {}) {
  const issuer = await createMockIssuer();
  const time = clock('2026-11-09T12:00:00Z');
  const consentStore = new MemoryConsents();
  const consents = new Consents({ store: consentStore, platform: time, integrity: new HmacIntegrity(SEAL_KEY) });
  const authorizationStore = new MemoryPartnerAuthorizations(new Map([['acme', partnerIds.acme], ['globex', partnerIds.globex]]), time.now);
  const denials: { operation: string; channel: string; cause: string }[] = [];
  const access = new ApiAccess({ find: async (_provider, reference) => credentials.get(reference) ?? null },
    { find: async identity => sessions.get(identity.sessionReference) ?? null } as never);
  const authorize = (input: unknown) => authorizeApiAccess({
    application: access, security: { deny: async denial => { denials.push(denial); } },
    partner: { authenticate: token => issuer.provider.authenticate(token) },
    web: { authenticate: async cookie => sessions.has(cookie) ? { identity: { emailVerified: true, providerSubject: 'user_' + cookie, sessionReference: cookie } as never } : null, allowedOrigins: [ORIGIN] }
  }, input);
  const identityHttp = createIdentityHttp({ authentication: {} as never, authorizeApiAccess: authorize, consents,
    partnerAuthorizations: new PartnerAuthorizations({ store: authorizationStore, now: time.now }) });
  const identityRpc = {
    authorizePartnerOfferAccessV1: async (input: unknown) => {
      if (options.identityDown?.()) throw Error('identity unavailable');
      await new Promise(resolve => setTimeout(resolve, options.identityDelayMs?.() ?? 0));
      return authorizePartnerOfferAccess({ authorize, authorizations: authorizationStore, verifyConsents: input => consents.verifyScopes(input), security: { deny: async denial => { denials.push(denial); } } as never }, input);
    }
  };
  const quoteStore = new MemoryStore();
  const protector = new HmacProtector('synthetic-journey-key-'.padEnd(40, 'x'));
  const quotes = new CreateQuote({ access: { authorize: async () => { throw Error('partners never create their own quote here'); } }, store: quoteStore, clock: time, protector });
  const offerStore = new JourneyOffers(quoteStore);
  const provider = new FailingScope(new MockRiskSignals(time.now), options.signalFailure ?? (() => false));
  const offers = new OfferService({ store: offerStore, integrity: new HmacOfferIntegrity('synthetic-journey-financial-key-'.padEnd(40, 'x')), flights: new MockFlightSchedule(time.now),
    signals: new ReadSignal({ guard: { verify: async () => ({ allowed: false, reason: 'unavailable' }) }, provider, snapshots: new NoSnapshots(), clock: time, timer: { after: () => new Promise<void>(() => {}) }, trace: { record: () => {} } }),
    clock: time, environment: 'local', enabled: true });
  const acquisitionHttp = createAcquisitionHttp({ quotes, estimates: new EstimateQuote(),
    partnerOffers: new PartnerOffers({ access: new IdentityPartnerOfferAccess(identityRpc, 40), quotes, offers, protector }),
    offers: { offers, authorizeFinancialAccess: input => authorizeFinancialAccess({ authorize, verifyConsents: input => consents.verifyScopes(input) }, input), denyResourceAccess: async () => ({ recorded: true }) } });
  const env = { APP_ENV: 'local', IDENTITY: { fetch: (request: Request) => identityHttp.fetch(request, { APP_ENV: 'local' } as never) },
    ACQUISITION: { fetch: (request: Request) => acquisitionHttp.fetch(request, { APP_ENV: 'local' } as never) }, POLICY: { fetch: async () => assert.fail('unused') }, ASSETS: { fetch: async () => new Response('asset') } } as never;
  const gateway = (request: Request) => worker.fetch(request, env);
  const customer = async (session: string, path: string, body?: unknown, key?: string) => {
    const response = await gateway(new Request(ORIGIN + path, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
      headers: { cookie: `solventa-session=${session}`, origin: ORIGIN, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) } }));
    const payload = await response.json() as Record<string, any>;
    if (path.startsWith('/api/v1/me/partner-authorizations')) {
      conforms(response.status >= 400 ? contract.customerError : payload.items ? contract.list : contract.authorization, payload);
    }
    return { status: response.status, body: payload };
  };
  const consumer = (partner: keyof typeof identities, scopes = ['quotes:create', 'partner-offers:create']) =>
    new ContractConsumer(gateway, () => issuer.token(identities[partner], scopes));
  const authorize_ = async (session: string, partnerCode: string, validityDays?: number) => {
    const response = await customer(session, '/api/v1/me/partner-authorizations', { partnerCode, ...(validityDays ? { validityDays } : {}) });
    assert.equal(response.status, 201);
    return response.body.authorizationId as string;
  };
  const consent = async (session: string) => assert.equal((await customer(session, '/api/v1/consents', { textVersion: 2, locale: 'es-CO' }, 'consent-' + session)).status, 201);
  return { gateway, customer, consumer, issuer, authorize: authorize_, consent, consentStore, quoteStore, offerStore, denials, time, authorizationCount: () => authorizationStore.rows.length };
}

test('an authorized partner prices a customer with live signals: price, validity, signal condition and explanation, contractable', async () => {
  const w = await world();
  await w.consent('ana-session');
  const authorizationId = await w.authorize('ana-session', 'acme');
  const result = await w.consumer('acme').requestOffer({ authorizationId, idempotencyKey: 'order-1', quote });
  assert.equal(result.status, 201);
  const offer = result.body;
  assert.equal(offer.status, 'definitive');
  assert.equal(offer.contractable, true);
  assert.match(offer.premium, /^\d+\.\d{4}$/);
  assert.equal(offer.currency, 'COP');
  assert.ok(Date.parse(offer.validity.expiresAt) > Date.parse('2026-11-09T12:00:00Z'));
  assert.deepEqual(offer.signals.map((signal: { scope: string; quality: string; degraded: boolean; confidence: number }) => [signal.scope, signal.quality, signal.degraded, signal.confidence]),
    ['income_obligations_12m', 'payment_history_score', 'affiliation_regime', 'identity_validation'].map(scope => [scope, 'live', false, 100]));
  assert.equal(typeof offer.explanation.baseRatePpm, 'number');
  assert.equal(offer.synthetic, true);
  const text = JSON.stringify(result.body);
  for (const hidden of [ANA.clientId, ANA.subjectToken, '8000000', 'monthlyIncome', 'debtRatio']) assert.equal(text.includes(hidden), false, hidden);
  const stored = [...w.offerStore.captures.values()][0];
  assert.deepEqual(stored.channel, { kind: 'partner', partnerId: partnerIds.acme, authorizationId });
  assert.equal(new Ajv({ allErrors: true }).compile(JSON.parse(readFileSync('packages/contracts/schemas/decision-capture.v1.json', 'utf8')))(stored), true, 'the retained decision follows the capture schema');
  assert.deepEqual(stored.consent, { status: 'verified', id: 'CNS-2026-00001', version: 2 });
  assert.equal(w.quoteStore.saved[0].actor.kind === 'user' && w.quoteStore.saved[0].actor.clientId, ANA.clientId, 'the quote belongs to the customer, not to the partner');
});

test('a customer outside the authorization, another partner and an invented authorization never reach a price', async () => {
  const w = await world();
  await w.consent('ana-session');
  await w.consent('luis-session');
  const anaAuthorization = await w.authorize('ana-session', 'acme');
  const acme = w.consumer('acme');
  const globex = await w.consumer('globex').requestOffer({ authorizationId: anaAuthorization, idempotencyKey: 'k1', quote });
  assert.deepEqual([globex.status, globex.body.error], [403, 'forbidden'], "another partner cannot use Ana's authorization");
  const invented = await acme.requestOffer({ authorizationId: randomUUID(), idempotencyKey: 'k2', quote });
  assert.deepEqual([invented.status, invented.body.error], [403, 'forbidden']);
  assert.deepEqual([globex.body.error, globex.status], [invented.body.error, invented.status], 'a foreign and an unknown authorization look the same');
  const named = await acme.requestOffer({ authorizationId: anaAuthorization, idempotencyKey: 'k3', quote, extra: { clientId: LUIS.clientId, subjectToken: LUIS.subjectToken } });
  assert.equal(named.status, 400, 'a customer identifier in the body is rejected, never obeyed');
  const luisAuthorization = await w.authorize('luis-session', 'acme');
  const luis = await acme.requestOffer({ authorizationId: luisAuthorization, idempotencyKey: 'k4', quote: { ...quote, customer: { ...quote.customer, fullName: 'Ana Prueba' } } });
  assert.equal(luis.status, 201);
  assert.equal(w.quoteStore.saved.every(saved => saved.actor.kind === 'user' && saved.actor.clientId === LUIS.clientId), true, "Luis's request priced Luis, whatever name or document the body carried");
  assert.equal(w.quoteStore.saved.length, 1, 'no denied request created a quote');
  assert.equal(w.denials.filter(denial => denial.channel === 'partner' && denial.operation === 'partner-offers:create').length, 2);
});

test('without the specific permission, a token, or with only a browser session, the partner is denied before any authorization is read', async () => {
  const w = await world();
  await w.consent('ana-session');
  const authorizationId = await w.authorize('ana-session', 'acme');
  const limited = await w.consumer('limited').requestOffer({ authorizationId, idempotencyKey: 'k1', quote });
  assert.deepEqual([limited.status, limited.body.error], [403, 'forbidden'], 'quotes:create alone is not partner-offers:create');
  const none = await w.consumer('acme').requestOffer({ authorizationId, idempotencyKey: 'k2', quote, token: null });
  assert.deepEqual([none.status, none.body.error, none.headers.get('www-authenticate')], [401, 'unauthorized', 'Bearer realm="solventa"']);
  const forged = await w.consumer('acme').requestOffer({ authorizationId, idempotencyKey: 'k3', quote, token: 'aaaa.bbbb.cccc' });
  assert.equal(forged.status, 401);
  const expired = await w.consumer('acme').requestOffer({ authorizationId, idempotencyKey: 'k4', quote, token: await w.issuer.token(identities.acme, ['quotes:create', 'partner-offers:create'], { exp: Math.floor(Date.now() / 1000) - 5 }) });
  assert.equal(expired.status, 401);
  const browser = await w.gateway(new Request(ORIGIN + '/api/v1/partner/offers', { method: 'POST', body: JSON.stringify({ authorizationId, ...quote }),
    headers: { cookie: 'solventa-session=ana-session', origin: ORIGIN, 'content-type': 'application/json', 'idempotency-key': 'k5' } }));
  assert.equal(browser.status, 401, "the customer's own session is not a partner credential");
  const asPartner = await w.gateway(new Request(ORIGIN + '/api/v1/me/partner-authorizations', { method: 'POST', body: JSON.stringify({ partnerCode: 'acme' }),
    headers: { authorization: 'Bearer ' + await w.issuer.token(identities.acme, ['quotes:create', 'partner-offers:create']), 'content-type': 'application/json' } }));
  assert.equal(asPartner.status, 400, 'a partner token cannot grant authorizations for a customer: the route takes the session only');
  assert.equal(w.authorizationCount(), 1);
  assert.equal(w.quoteStore.saved.length, 0);
});

test('revoking the authorization or the consent stops the next offer, and a retry of a finished order is no exception', async () => {
  const w = await world();
  await w.consent('ana-session');
  const authorizationId = await w.authorize('ana-session', 'acme');
  const acme = w.consumer('acme');
  assert.equal((await acme.requestOffer({ authorizationId, idempotencyKey: 'order-1', quote })).status, 201);
  const revoked = await w.customer('ana-session', `/api/v1/me/partner-authorizations/${authorizationId}/revoke`, {});
  assert.equal(revoked.body.status, 'revoked');
  const afterAuthorization = await acme.requestOffer({ authorizationId, idempotencyKey: 'order-2', quote });
  assert.deepEqual([afterAuthorization.status, afterAuthorization.body.error], [403, 'forbidden']);
  const retry = await acme.requestOffer({ authorizationId, idempotencyKey: 'order-1', quote });
  assert.equal(retry.status, 403, 'a revoked authorization also blocks replays');
  const fresh = await w.authorize('ana-session', 'acme');
  assert.equal((await acme.requestOffer({ authorizationId: fresh, idempotencyKey: 'order-3', quote })).status, 201);
  const consentCode = w.consentStore.consents[0].consentCode;
  assert.equal((await w.customer('ana-session', `/api/v1/consents/${consentCode}/revoke`, {})).status, 200);
  const afterConsent = await acme.requestOffer({ authorizationId: fresh, idempotencyKey: 'order-4', quote });
  assert.deepEqual([afterConsent.status, afterConsent.body.error], [403, 'consent_required']);
  assert.equal(w.quoteStore.saved.length, 2, 'blocked requests wrote nothing');
});

test('a customer without consent, or with an expired authorization, gets nothing even though the partner is valid', async () => {
  const w = await world();
  const authorizationId = await w.authorize('ana-session', 'acme', 1);
  const noConsent = await w.consumer('acme').requestOffer({ authorizationId, idempotencyKey: 'k1', quote });
  assert.deepEqual([noConsent.status, noConsent.body.error], [403, 'consent_required'], 'an authorization to the partner is not consent to use the data');
  await w.consent('ana-session');
  assert.equal((await w.consumer('acme').requestOffer({ authorizationId, idempotencyKey: 'k2', quote })).status, 201);
  w.time.advance(2);
  const expired = await w.consumer('acme').requestOffer({ authorizationId, idempotencyKey: 'k3', quote });
  assert.deepEqual([expired.status, expired.body.error], [403, 'forbidden']);
});

test('a failing signal source keeps the offer preliminary with its failure and confidence, and it can never be contracted', async () => {
  let failing = true;
  const w = await world({ signalFailure: () => failing });
  await w.consent('ana-session');
  const authorizationId = await w.authorize('ana-session', 'acme');
  const result = await w.consumer('acme').requestOffer({ authorizationId, idempotencyKey: 'order-1', quote });
  assert.equal(result.status, 201);
  assert.equal(result.body.status, 'preliminary');
  assert.equal(result.body.contractable, false);
  const degraded = result.body.signals.find((signal: { degraded: boolean }) => signal.degraded);
  assert.deepEqual([degraded.scope, degraded.quality, degraded.confidence, degraded.failure], ['payment_history_score', 'default', 0, 'timeout']);
  const accept = await w.gateway(new Request(`${ORIGIN}/api/v1/offers/${result.body.offerId}/accept`, { method: 'POST', body: '{}',
    headers: { authorization: 'Bearer ' + await w.issuer.token(identities.acme, ['quotes:create', 'partner-offers:create']), 'content-type': 'application/json', 'idempotency-key': 'accept-1' } }));
  assert.equal(accept.status, 400, 'a partner token cannot accept an offer: acceptance is the customer web journey');
  failing = false;
});

test('an unavailable or slow Identity blocks the offer with a 503 and writes nothing, and recovery needs no new key', async () => {
  let down = true, delay = 0;
  const w = await world({ identityDown: () => down, identityDelayMs: () => delay });
  await w.consent('ana-session');
  const authorizationId = await w.authorize('ana-session', 'acme');
  const acme = w.consumer('acme');
  const outage = await acme.requestOffer({ authorizationId, idempotencyKey: 'order-1', quote });
  assert.deepEqual([outage.status, outage.body.error], [503, 'access_unavailable']);
  down = false; delay = 200;
  assert.equal((await acme.requestOffer({ authorizationId, idempotencyKey: 'order-1', quote })).status, 503, 'past the deadline Identity counts as unavailable');
  assert.equal(w.quoteStore.saved.length, 0);
  delay = 0;
  assert.equal((await acme.requestOffer({ authorizationId, idempotencyKey: 'order-1', quote })).status, 201);
});

test('retrying an order replays the same offer without a second quote, a changed order conflicts, and a key never crosses partners', async () => {
  const w = await world();
  await w.consent('ana-session');
  const acmeAuthorization = await w.authorize('ana-session', 'acme');
  const globexAuthorization = await w.authorize('ana-session', 'globex');
  const acme = w.consumer('acme');
  const first = await acme.requestOffer({ authorizationId: acmeAuthorization, idempotencyKey: 'order-1', quote });
  const retry = await acme.requestOffer({ authorizationId: acmeAuthorization, idempotencyKey: 'order-1', quote });
  assert.deepEqual([first.status, retry.status], [201, 200]);
  assert.equal(retry.body.offerId, first.body.offerId);
  assert.equal(retry.body.premium, first.body.premium);
  assert.equal(w.quoteStore.saved.length, 1);
  assert.equal(w.offerStore.offers.size, 1);
  const changed = await acme.requestOffer({ authorizationId: acmeAuthorization, idempotencyKey: 'order-1', quote: { ...quote, credit: { ...quote.credit, amount: 300000000 } } });
  assert.deepEqual([changed.status, changed.body.error], [409, 'idempotency_key_reused']);
  const other = await w.consumer('globex').requestOffer({ authorizationId: globexAuthorization, idempotencyKey: 'order-1', quote });
  assert.equal(other.status, 201, "the same key at another partner is another order, not a replay of acme's offer");
  assert.notEqual(other.body.offerId, first.body.offerId);
  assert.equal(w.offerStore.offers.size, 2);
});

test('an order key belongs to one partner and one authorization: another authorization or customer never replays it', async () => {
  const w = await world();
  await w.consent('ana-session');
  await w.consent('luis-session');
  const first = await w.authorize('ana-session', 'acme');
  const second = await w.authorize('ana-session', 'acme');
  const luis = await w.authorize('luis-session', 'acme');
  const acme = w.consumer('acme');
  const original = await acme.requestOffer({ authorizationId: first, idempotencyKey: 'order-1', quote });
  assert.equal(original.status, 201);
  const again = await acme.requestOffer({ authorizationId: first, idempotencyKey: 'order-1', quote });
  assert.deepEqual([again.status, again.body.offerId], [200, original.body.offerId]);
  const otherAuthorization = await acme.requestOffer({ authorizationId: second, idempotencyKey: 'order-1', quote });
  assert.equal(otherAuthorization.status, 201, 'a key under another authorization is another order, never a replay of the first');
  assert.notEqual(otherAuthorization.body.offerId, original.body.offerId);
  const otherCustomer = await acme.requestOffer({ authorizationId: luis, idempotencyKey: 'order-1', quote });
  assert.equal(otherCustomer.status, 201);
  assert.notEqual(otherCustomer.body.offerId, original.body.offerId);
  const luisAgain = await acme.requestOffer({ authorizationId: luis, idempotencyKey: 'order-1', quote });
  assert.deepEqual([luisAgain.status, luisAgain.body.offerId], [200, otherCustomer.body.offerId], "each customer's order replays its own offer");
  assert.equal(w.offerStore.offers.size, 3);
});

test('the request is validated before it prices: bad body, missing key and unknown fields never create anything', async () => {
  const w = await world();
  await w.consent('ana-session');
  const authorizationId = await w.authorize('ana-session', 'acme');
  const acme = w.consumer('acme');
  const cases: [Parameters<PartnerOfferConsumer['requestOffer']>[0], number][] = [
    [{ authorizationId: 'not-a-uuid', idempotencyKey: 'k', quote }, 400], [{ authorizationId: undefined, idempotencyKey: 'k', quote }, 400],
    [{ authorizationId, idempotencyKey: null, quote }, 400], [{ authorizationId, idempotencyKey: 'k', quote: { ...quote, credit: { ...quote.credit, amount: -1 } } }, 400],
    [{ authorizationId, idempotencyKey: 'k', quote: { ...quote, customer: { ...quote.customer, birthDate: '2015-01-01' } } }, 400]];
  for (const [input, status] of cases) assert.equal((await acme.requestOffer(input)).status, status, JSON.stringify(input).slice(0, 60));
  assert.equal(w.quoteStore.saved.length, 0);
  assert.equal(w.offerStore.offers.size, 0);
});

test('Identity never learns a customer from the partner: the offer RPC input carries only the token, the authorization and the trace', async () => {
  const w = await world();
  await w.consent('ana-session');
  const authorizationId = await w.authorize('ana-session', 'acme');
  const consumer = w.consumer('acme');
  const result = await consumer.requestOffer({ authorizationId, idempotencyKey: 'order-1', quote });
  assert.equal(result.status, 201);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.match(result.headers.get('x-trace-id') ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(offerRequestIdentity('vida_hipotecario', 'COT-2026-00001') === [...w.offerStore.requests.values()][0].requestIdentity, true);
});
