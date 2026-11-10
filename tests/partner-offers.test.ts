import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHttp } from '../backend/acquisition-risk/src/adapters/inbound/http';
import { HmacProtector } from '../backend/acquisition-risk/src/adapters/outbound/hmac-protector';
import { IdentityPartnerOfferAccess } from '../backend/acquisition-risk/src/adapters/outbound/identity-partner-offer-access';
import { PartnerOffers } from '../backend/acquisition-risk/src/application/partner-offers';
import type { PartnerOfferAccess, PartnerOfferDecision } from '../backend/acquisition-risk/src/application/ports/partner-offer-access';
import { CONFIDENCE } from '../backend/acquisition-risk/src/domain/signal';
import { underwrite, offerTerms, type OfferQuote } from '../backend/acquisition-risk/src/domain/offer';
import { partnerOfferView } from '../backend/acquisition-risk/src/domain/partner-offer';
import type { Signal } from '../backend/acquisition-risk/src/domain/signal';

// The handler logs one profiling line per request; each test file runs in its own process.
console.log = () => {};
const partnerId = randomUUID();
const customer = { clientId: randomUUID(), subjectToken: randomUUID() };
const authorizationId = randomUUID();
const consent = { consentId: 'CNS-2026-00001', textVersion: 2, expiresAt: '2027-01-01T00:00:00.000Z' };
const allowed = (overrides: Partial<Extract<PartnerOfferDecision, { allowed: true }>> = {}): PartnerOfferDecision =>
  ({ allowed: true, partnerId, customer, consent, authorizationExpiresAt: '2026-12-09T12:00:00.000Z', ...overrides });
const quoteBody = { product: 'vida_hipotecario', customer: { fullName: 'Ana Prueba', documentType: 'CC', documentNumber: '1000000001', birthDate: '1990-05-17', city: 'Bogota' },
  credit: { partnerCreditId: 'CR-1', amount: 200000000, termMonths: 120 } };
const quote = { quoteId: 'COT-2026-00001', premiumMonthly: 1, sumInsured: 200000000, termMonths: 120, validUntil: '2026-12-31T00:00:00.000Z', ruleVersion: 'provisional-1' };
const signals: Signal[] = [
  { scope: 'income_obligations_12m', capturedAt: '2026-11-09T12:00:00.000Z', data: { monthlyIncomeCop: 8000000, monthlyObligationsCop: 1800000 } },
  { scope: 'payment_history_score', capturedAt: '2026-11-09T12:00:00.000Z', data: { score: 780 } },
  { scope: 'affiliation_regime', capturedAt: '2026-11-09T12:00:00.000Z', data: { active: true } },
  { scope: 'identity_validation', capturedAt: '2026-11-09T12:00:00.000Z', data: { verified: true } }];
const offerQuote: OfferQuote = { id: randomUUID(), quoteId: quote.quoteId, amount: 200000000, termMonths: 120, ageYears: 36, validUntil: quote.validUntil };
const provenance = (degraded: boolean) => signals.map((signal, index) => degraded && index === 1
  ? { scope: signal.scope, quality: 'default' as const, degraded: true, confidence: CONFIDENCE.default, failure: 'timeout' as const, substitute: 'default' as const }
  : { scope: signal.scope, quality: 'live' as const, degraded: false, confidence: CONFIDENCE.live });

function offerFixture(degraded = false) {
  const decision = underwrite(offerQuote, signals, consent, randomUUID(), provenance(degraded));
  if (!decision) throw Error('unreachable');
  const terms = offerTerms(offerQuote, customer, randomUUID(), decision.premium, new Date('2026-11-09T12:00:00.000Z'), consent.expiresAt, decision.preliminary ? 'preliminary' : 'definitive');
  return { terms, capture: decision.capture };
}

function fixture(options: { access?: PartnerOfferAccess; offer?: unknown; quote?: unknown } = {}) {
  const calls = { access: [] as unknown[], quotes: [] as unknown[], offers: [] as unknown[] };
  const { terms, capture } = offerFixture();
  const service = new PartnerOffers({
    access: options.access ?? { authorize: async input => { calls.access.push(input); return allowed(); } },
    quotes: { createFor: async (actor, input) => { calls.quotes.push({ actor, input }); return (options.quote ?? { status: 'created', quote: { ...quote, currency: 'COP', basis: 'minimum_data', traceId: input.traceId } }) as never; } },
    offers: { create: async input => { calls.offers.push(input); return (options.offer ?? { status: 'created', offer: terms }) as never; }, explanation: async () => capture },
    protector: new HmacProtector('synthetic-partner-key-'.padEnd(40, 'x'))
  });
  return { service, calls, terms };
}
const request = (overrides: Record<string, unknown> = {}) => ({ token: 'partner.jwt', body: { authorizationId, ...quoteBody }, idempotencyKey: 'order-1', traceId: randomUUID(), ...overrides });

test('the customer comes from Identity, the quote and offer share one partner-scoped key and the offer names its partner channel', async () => {
  const f = fixture();
  const result = await f.service.create(request());
  assert.equal(result.status, 'created');
  const [{ actor, input }] = f.calls.quotes as { actor: unknown; input: { idempotencyKey: string; body: Record<string, unknown> } }[];
  assert.deepEqual(actor, { kind: 'user', ...customer });
  assert.equal('authorizationId' in input.body, false, 'the authorization is not part of the quote request');
  const [offer] = f.calls.offers as { idempotencyKey: string; actor: unknown; channel: unknown; quoteId: string; authorization: { expiresAt: string } }[];
  assert.equal(offer.idempotencyKey, input.idempotencyKey);
  assert.notEqual(input.idempotencyKey, 'order-1');
  assert.deepEqual(offer.actor, customer);
  assert.deepEqual(offer.channel, { kind: 'partner', partnerId, authorizationId });
  assert.equal(offer.quoteId, quote.quoteId);
});

test('the offer window ends with the earlier of the customer consent and the authorization given to the partner', async () => {
  for (const [authorizationExpiresAt, expected] of [['2026-12-09T12:00:00.000Z', '2026-12-09T12:00:00.000Z'], ['2028-01-01T00:00:00.000Z', consent.expiresAt]]) {
    const f = fixture({ access: { authorize: async () => allowed({ authorizationExpiresAt }) } });
    await f.service.create(request());
    assert.equal((f.calls.offers[0] as { authorization: { expiresAt: string } }).authorization.expiresAt, expected);
  }
});

test('a partner key never replays another partner result and a body customer id never selects the customer', async () => {
  const protector = new HmacProtector('synthetic-partner-key-'.padEnd(40, 'x'));
  const [a, again, b, c, d] = await Promise.all([protector.partnerKey(partnerId, authorizationId, 'order-1'), protector.partnerKey(partnerId, authorizationId, 'order-1'),
    protector.partnerKey(randomUUID(), authorizationId, 'order-1'), protector.partnerKey(partnerId, authorizationId, 'order-2'), protector.partnerKey(partnerId, randomUUID(), 'order-1')]);
  assert.equal(a, again); assert.notEqual(a, b); assert.notEqual(a, c); assert.notEqual(a, d);
  assert.match(a, /^[0-9a-f]{64}$/);
  const f = fixture();
  await f.service.create(request({ body: { authorizationId, clientId: randomUUID(), subjectToken: randomUUID(), ...quoteBody } }));
  assert.deepEqual((f.calls.quotes[0] as { actor: unknown }).actor, { kind: 'user', ...customer });
  assert.equal(((f.calls.quotes[0] as { input: { body: Record<string, unknown> } }).input.body).clientId !== undefined, true, 'unknown properties reach quote validation, which rejects them');
});

test('without a valid authorization id the request fails before Identity is called, and nothing is written', async () => {
  for (const body of [undefined, null, [], {}, { authorizationId: 7 }, { authorizationId: 'nope', ...quoteBody }]) {
    const f = fixture();
    const result = await f.service.create(request({ body }));
    assert.equal(result.status, 'invalid');
    assert.deepEqual([f.calls.access.length, f.calls.quotes.length, f.calls.offers.length], [0, 0, 0]);
  }
});

test('every Identity denial blocks the offer; an invalid-request answer is an integration failure, never a caller error', async () => {
  for (const [decision, expected] of [
    [{ allowed: false, error: 'unauthorized', status: 401 }, [401, 'unauthorized']], [{ allowed: false, error: 'forbidden', status: 403 }, [403, 'forbidden']],
    [{ allowed: false, error: 'consent_required', status: 403 }, [403, 'consent_required']], [{ allowed: false, error: 'access_unavailable', status: 503 }, [503, 'access_unavailable']],
    [{ allowed: false, error: 'invalid_request', status: 400 }, [503, 'access_unavailable']]] as [PartnerOfferDecision, [number, string]][]) {
    const f = fixture({ access: { authorize: async () => decision } });
    const result = await f.service.create(request());
    assert.deepEqual(result.status === 'denied' ? [result.httpStatus, result.error] : null, expected);
    assert.deepEqual([f.calls.quotes.length, f.calls.offers.length], [0, 0]);
  }
});

test('the idempotency key is required and bounded, and a key reused with another request creates no offer', async () => {
  for (const [key, field] of [[null, 'required'], ['', 'required'], ['k'.repeat(129), 'invalid_format']] as const) {
    const f = fixture();
    const result = await f.service.create(request({ idempotencyKey: key }));
    assert.deepEqual(result.status === 'invalid' ? result.errors : null, [{ field: 'Idempotency-Key', code: field }]);
    assert.equal(f.calls.quotes.length, 0);
  }
  const conflict = fixture({ quote: { status: 'idempotency_conflict' } });
  assert.equal((await conflict.service.create(request())).status, 'idempotency_conflict');
  assert.equal(conflict.calls.offers.length, 0);
  const invalid = fixture({ quote: { status: 'invalid', errors: [{ field: 'credit.amount', code: 'required' }] } });
  assert.equal((await invalid.service.create(request())).status, 'invalid');
  assert.equal(invalid.calls.offers.length, 0);
});

test('offer outcomes map to partner results: consent lost mid-request is denied, the rest never become success', async () => {
  const cases: [string, unknown][] = [['denied', { status: 'denied' }], ['declined', { status: 'declined' }], ['unavailable', { status: 'unavailable' }],
    ['conflict', { status: 'expired' }], ['conflict', { status: 'conflict' }], ['conflict', { status: 'not_found' }]];
  for (const [expected, offer] of cases) {
    const result = await fixture({ offer }).service.create(request());
    assert.equal(result.status === 'denied' ? result.error : result.status, expected === 'denied' ? 'consent_required' : expected);
  }
  assert.equal((await fixture({ offer: { status: 'replayed', offer: offerFixture().terms } }).service.create(request())).status, 'replayed');
});

test('the response states price, validity, signal source condition and explanation, and leaks no customer data', () => {
  const { terms, capture } = offerFixture();
  const view = partnerOfferView(terms, capture);
  assert.equal(view.contractable, true);
  assert.equal(view.premium, terms.premium);
  assert.deepEqual(view.validity, { effectiveFrom: terms.effectiveFrom, effectiveUntil: terms.effectiveUntil, expiresAt: terms.expiresAt });
  assert.deepEqual(view.signals.map(signal => [signal.scope, signal.quality, signal.degraded, signal.confidence]),
    signals.map(signal => [signal.scope, 'live', false, 100]));
  assert.equal(view.explanation.ratingVersion, capture.inputs.baseRuleVersion);
  const text = JSON.stringify(view);
  for (const secret of [customer.clientId, customer.subjectToken, '8000000', '1800000', 'debtRatio', 'paymentScore', 'monthlyIncome']) assert.equal(text.includes(secret), false, secret);
});

test('a degraded signal keeps the offer preliminary, flagged with its failure, and never contractable', () => {
  const { terms, capture } = offerFixture(true);
  const view = partnerOfferView(terms, capture);
  assert.equal(terms.status, 'preliminary');
  assert.equal(view.status, 'preliminary');
  assert.equal(view.contractable, false);
  const degraded = view.signals.find(signal => signal.degraded);
  assert.deepEqual(degraded && [degraded.scope, degraded.quality, degraded.confidence, degraded.failure], ['payment_history_score', 'default', 0, 'timeout']);
});

function httpFixture(service: Pick<PartnerOffers, 'create'>) {
  const app = createHttp({ quotes: {} as never, estimates: {} as never, partnerOffers: service as PartnerOffers });
  return (init: RequestInit = {}, path = '/api/v1/partner/offers') => app.request('http://localhost' + path, { method: 'POST', ...init, headers: { 'content-type': 'application/json', ...init.headers } }, { APP_ENV: 'local' } as never);
}
const view = partnerOfferView(offerFixture().terms, offerFixture().capture);

test('HTTP: only POST with a Bearer partner token reaches the use case, with the body, key and trace passed through', async () => {
  const seen: { token: string; body: unknown; idempotencyKey: string | null; traceId: string }[] = [];
  const call = httpFixture({ create: async input => { seen.push(input); return { status: 'created', offer: view }; } });
  const trace = randomUUID();
  const response = await call({ body: JSON.stringify({ authorizationId }), headers: { authorization: 'Bearer abc.def.ghi', 'idempotency-key': 'k1', 'x-trace-id': trace } });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-trace-id'), trace);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(seen[0], { token: 'abc.def.ghi', body: { authorizationId }, idempotencyKey: 'k1', traceId: trace, timings: seen[0] && (seen[0] as never as { timings: unknown }).timings });
  const noToken = await call({ body: '{}', headers: { cookie: 'solventa-session=sealed' } });
  assert.equal(noToken.status, 201);
  assert.equal(seen[1].token, '', 'a browser session is not a partner credential');
  const get = await call({ method: 'GET' });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
});

test('HTTP: results map to precise statuses and bodies, with a bearer challenge only for 401', async () => {
  const outcomes: [Awaited<ReturnType<PartnerOffers['create']>>, number, string | undefined][] = [
    [{ status: 'replayed', offer: view }, 200, undefined], [{ status: 'denied', error: 'unauthorized', httpStatus: 401 }, 401, 'unauthorized'],
    [{ status: 'denied', error: 'forbidden', httpStatus: 403 }, 403, 'forbidden'], [{ status: 'denied', error: 'consent_required', httpStatus: 403 }, 403, 'consent_required'],
    [{ status: 'denied', error: 'access_unavailable', httpStatus: 503 }, 503, 'access_unavailable'], [{ status: 'invalid', errors: [{ field: 'credit.amount', code: 'required' }] }, 400, 'validation_error'],
    [{ status: 'idempotency_conflict' }, 409, 'idempotency_key_reused'], [{ status: 'declined' }, 409, 'declined'], [{ status: 'conflict' }, 409, 'conflict'],
    [{ status: 'unavailable' }, 503, 'financial_unavailable']];
  for (const [result, status, error] of outcomes) {
    const response = await httpFixture({ create: async () => result })({ body: '{}' });
    const body = await response.json() as { error?: string; traceId: string };
    assert.equal(response.status, status);
    assert.equal(body.error, error);
    assert.match(body.traceId, /^[0-9a-f-]{36}$/);
    assert.equal(response.headers.get('www-authenticate') !== null, status === 401);
  }
});

test('HTTP: oversized or malformed bodies reach the use case as no body, and an unexpected failure is a safe 500 with no detail', async () => {
  const bodies: unknown[] = [];
  const call = httpFixture({ create: async input => { bodies.push(input.body); return { status: 'invalid', errors: [] }; } });
  await call({ body: '{' });
  await call({ body: JSON.stringify({ authorizationId, pad: 'x'.repeat(5000) }) });
  assert.deepEqual(bodies, [undefined, undefined]);
  const errors = console.error; const logged: string[] = [];
  console.error = (line: string) => { logged.push(line); };
  try {
    const response = await httpFixture({ create: async () => { throw Object.assign(Error('secret 10.0.0.7'), { code: 'ECONNRESET' }); } })({ body: '{}' });
    const text = await response.text();
    assert.equal(response.status, 500);
    assert.equal(text.includes('10.0.0.7'), false);
    assert.equal(logged.some(line => line.includes('10.0.0.7')), false);
  } finally { console.error = errors; }
});

test('HTTP: every attempt logs one mortgage_offer_profiled line for the partner channel, with its dependency timings and no customer data', async () => {
  const lines: string[] = []; const log = console.log;
  console.log = (line: string) => { lines.push(line); };
  try {
    await httpFixture({ create: async input => { await input.timings?.measure('identity_access', async () => {}); return { status: 'created', offer: view }; } })({ body: '{}' });
  } finally { console.log = log; }
  const event = JSON.parse(lines.find(line => line.includes('mortgage_offer_profiled')) ?? '{}');
  assert.equal(event.channel, 'partner');
  assert.equal(event.result, 'created');
  assert.equal(event.offerStatus, 'definitive');
  assert.deepEqual(event.dependencies.map((dependency: { name: string }) => dependency.name), ['identity_access']);
  assert.equal(JSON.stringify(event).includes(customer.clientId), false);
});

test('the Identity adapter validates the untrusted reply, drops oversized tokens and bounds the call by its deadline', async () => {
  const sent: unknown[] = [];
  const identity = (reply: unknown, delay = 0) => new IdentityPartnerOfferAccess({ authorizePartnerOfferAccessV1: async request => { sent.push(request); await new Promise(resolve => setTimeout(resolve, delay)); return reply; } }, 30);
  const input = { token: 'partner.jwt.token', authorizationId, traceId: randomUUID() };
  const good = { allowed: true, partnerId, customer, consent, authorizationExpiresAt: '2026-12-09T12:00:00.000Z' };
  assert.deepEqual(await identity(good).authorize(input), allowed());
  const unavailable = { allowed: false, error: 'access_unavailable', status: 503 };
  for (const reply of [null, 'ok', {}, { allowed: true }, { ...good, partnerId: 'x' }, { ...good, customer: { ...customer, clientId: 'x' } }, { ...good, consent: { ...consent, consentId: 'CNS-1' } },
    { ...good, consent: { ...consent, textVersion: 0 } }, { ...good, consent: { ...consent, expiresAt: 'later' } }, { ...good, authorizationExpiresAt: 'soon' },
    { allowed: false, error: 'invalid_request', status: 400 }, { allowed: false, error: 'forbidden', status: 401 }, { allowed: false, status: 500 }]) {
    assert.deepEqual(await identity(reply).authorize(input), unavailable, JSON.stringify(reply));
  }
  assert.deepEqual(await identity({ allowed: false, error: 'unauthorized', status: 401 }).authorize(input), { allowed: false, error: 'unauthorized', status: 401 });
  assert.deepEqual(await identity({ allowed: false, error: 'consent_required', status: 403 }).authorize(input), { allowed: false, error: 'consent_required', status: 403 });
  assert.deepEqual(await identity(good, 200).authorize(input), unavailable, 'a slow Identity blocks the offer');
  sent.length = 0;
  await identity(good).authorize({ ...input, token: 'x'.repeat(9000) });
  assert.equal((sent[0] as { token: string }).token, '');
  const failing = new IdentityPartnerOfferAccess({ authorizePartnerOfferAccessV1: async () => { throw Error('binding closed'); } });
  assert.deepEqual(await failing.authorize(input), unavailable);
});
