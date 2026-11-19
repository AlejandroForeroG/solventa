import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHttp } from '../backend/acquisition-risk/src/adapters/inbound/http';
import { HmacProtector } from '../backend/acquisition-risk/src/adapters/outbound/hmac-protector';
import { IdentityAdvisorSaleAccess } from '../backend/acquisition-risk/src/adapters/outbound/identity-advisor-sale-access';
import { AdvisorOffers } from '../backend/acquisition-risk/src/application/advisor-offers';
import type { AdvisorSaleAccess, AdvisorSaleDecision } from '../backend/acquisition-risk/src/application/ports/advisor-sale-access';
import { CONFIDENCE } from '../backend/acquisition-risk/src/domain/signal';
import { underwrite, offerTerms, type OfferQuote } from '../backend/acquisition-risk/src/domain/offer';
import { partnerOfferView } from '../backend/acquisition-risk/src/domain/partner-offer';
import type { Signal } from '../backend/acquisition-risk/src/domain/signal';

// The handler logs one profiling line per request; each test file runs in its own process.
console.log = () => {};
const advisorReference = randomUUID();
const customer = { clientId: randomUUID(), subjectToken: randomUUID() };
const authorizationId = randomUUID();
const consent = { consentId: 'CNS-2026-00001', textVersion: 2, expiresAt: '2027-01-01T00:00:00.000Z' };
const allowed = (overrides: Partial<Extract<AdvisorSaleDecision, { allowed: true }>> = {}): AdvisorSaleDecision =>
  ({ allowed: true, advisorReference, customer, consent, authorizationExpiresAt: '2026-11-10T12:00:00.000Z', ...overrides });
const quoteBody = { product: 'vida_hipotecario', customer: { fullName: 'Ana Prueba', documentType: 'CC', documentNumber: '1000000001', birthDate: '1990-05-17', city: 'Bogota' },
  credit: { partnerCreditId: 'CR-1', amount: 200000000, termMonths: 120 } };
const quote = { quoteId: 'COT-2026-00001', premiumMonthly: 1, sumInsured: 200000000, termMonths: 120, validUntil: '2026-12-31T00:00:00.000Z', ruleVersion: 'provisional-1' };
const signals: Signal[] = [
  { scope: 'income_obligations_12m', capturedAt: '2026-11-09T12:00:00.000Z', data: { monthlyIncomeCop: 8000000, monthlyObligationsCop: 1800000 } },
  { scope: 'payment_history_score', capturedAt: '2026-11-09T12:00:00.000Z', data: { score: 780 } },
  { scope: 'affiliation_regime', capturedAt: '2026-11-09T12:00:00.000Z', data: { active: true } },
  { scope: 'identity_validation', capturedAt: '2026-11-09T12:00:00.000Z', data: { verified: true } }];
const offerQuote: OfferQuote = { id: randomUUID(), quoteId: quote.quoteId, amount: 200000000, termMonths: 120, ageYears: 36, validUntil: quote.validUntil };
const provenance = signals.map(signal => ({ scope: signal.scope, quality: 'live' as const, degraded: false, confidence: CONFIDENCE.live }));

function offerFixture() {
  const decision = underwrite(offerQuote, signals, consent, randomUUID(), provenance);
  if (!decision) throw Error('unreachable');
  const terms = offerTerms(offerQuote, customer, randomUUID(), decision.premium, new Date('2026-11-09T12:00:00.000Z'), consent.expiresAt, decision.preliminary ? 'preliminary' : 'definitive');
  return { terms, capture: decision.capture };
}

const session = { cookie: 'sealed-session', origin: 'http://localhost', requestOrigin: 'http://localhost', method: 'POST' };
function fixture(options: { access?: AdvisorSaleAccess; offer?: unknown; quote?: unknown } = {}) {
  const calls = { access: [] as unknown[], quotes: [] as unknown[], offers: [] as unknown[] };
  const { terms, capture } = offerFixture();
  const service = new AdvisorOffers({
    access: options.access ?? { authorize: async input => { calls.access.push(input); return allowed(); } },
    quotes: { createFor: async (actor, input) => { calls.quotes.push({ actor, input }); return (options.quote ?? { status: 'created', quote: { ...quote, currency: 'COP', basis: 'minimum_data', traceId: input.traceId } }) as never; } },
    offers: { create: async input => { calls.offers.push(input); return (options.offer ?? { status: 'created', offer: terms }) as never; }, explanation: async () => capture },
    protector: new HmacProtector('synthetic-advisor-key-'.padEnd(40, 'x'))
  });
  return { service, calls, terms };
}
const request = (overrides: Record<string, unknown> = {}) => ({ session, body: { authorizationId, ...quoteBody }, idempotencyKey: 'sale-1', traceId: randomUUID(), ...overrides });

test('the customer comes from Identity, the quote and offer share one advisor-scoped key and the offer names its advisor channel', async () => {
  const f = fixture();
  const result = await f.service.create(request());
  assert.equal(result.status, 'created');
  const [{ actor, input }] = f.calls.quotes as { actor: unknown; input: { idempotencyKey: string; body: Record<string, unknown> } }[];
  assert.deepEqual(actor, { kind: 'user', ...customer }, 'the offer belongs to the customer, not to the advisor');
  assert.equal('authorizationId' in input.body, false, 'the authorization is not part of the quote request');
  const [offer] = f.calls.offers as { idempotencyKey: string; actor: unknown; channel: unknown; quoteId: string }[];
  assert.equal(offer.idempotencyKey, input.idempotencyKey);
  assert.notEqual(input.idempotencyKey, 'sale-1');
  assert.deepEqual(offer.actor, customer);
  assert.deepEqual(offer.channel, { kind: 'advisor', advisorReference, authorizationId });
  assert.equal(offer.quoteId, quote.quoteId);
  assert.deepEqual((f.calls.access[0] as { session: unknown }).session, session, 'the advisor session reaches Identity untouched');
});

test('the offer window ends with the earlier of the customer consent and the authorization given to the advisor', async () => {
  for (const [authorizationExpiresAt, expected] of [['2026-11-10T12:00:00.000Z', '2026-11-10T12:00:00.000Z'], ['2028-01-01T00:00:00.000Z', consent.expiresAt]]) {
    const f = fixture({ access: { authorize: async () => allowed({ authorizationExpiresAt }) } });
    await f.service.create(request());
    assert.equal((f.calls.offers[0] as { authorization: { expiresAt: string } }).authorization.expiresAt, expected);
  }
});

test('an advisor key never replays another advisor, authorization or key, and never collides with a partner key', async () => {
  const protector = new HmacProtector('synthetic-advisor-key-'.padEnd(40, 'x'));
  const [a, again, b, c, d, partner] = await Promise.all([protector.advisorKey(advisorReference, authorizationId, 'sale-1'), protector.advisorKey(advisorReference, authorizationId, 'sale-1'),
    protector.advisorKey(randomUUID(), authorizationId, 'sale-1'), protector.advisorKey(advisorReference, authorizationId, 'sale-2'), protector.advisorKey(advisorReference, randomUUID(), 'sale-1'),
    protector.partnerKey(advisorReference, authorizationId, 'sale-1')]);
  assert.equal(a, again); assert.notEqual(a, b); assert.notEqual(a, c); assert.notEqual(a, d); assert.notEqual(a, partner);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('a body customer id never selects the customer', async () => {
  const f = fixture();
  await f.service.create(request({ body: { authorizationId, clientId: randomUUID(), subjectToken: randomUUID(), ...quoteBody } }));
  assert.deepEqual((f.calls.quotes[0] as { actor: unknown }).actor, { kind: 'user', ...customer });
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
    [{ allowed: false, error: 'invalid_request', status: 400 }, [503, 'access_unavailable']]] as [AdvisorSaleDecision, [number, string]][]) {
    const f = fixture({ access: { authorize: async () => decision } });
    const result = await f.service.create(request());
    assert.deepEqual(result.status === 'denied' ? [result.httpStatus, result.error] : null, expected);
    assert.deepEqual([f.calls.quotes.length, f.calls.offers.length], [0, 0]);
  }
});

test('the idempotency key is required and bounded, and a key reused with another request creates no offer', async () => {
  for (const [key, code] of [[null, 'required'], ['', 'required'], ['k'.repeat(129), 'invalid_format']] as const) {
    const f = fixture();
    const result = await f.service.create(request({ idempotencyKey: key }));
    assert.deepEqual(result.status === 'invalid' ? result.errors : null, [{ field: 'Idempotency-Key', code }]);
    assert.equal(f.calls.quotes.length, 0);
  }
  const conflict = fixture({ quote: { status: 'idempotency_conflict' } });
  assert.equal((await conflict.service.create(request())).status, 'idempotency_conflict');
  assert.equal(conflict.calls.offers.length, 0);
});

test('offer outcomes never become success unless created or replayed, and a replay is reported as such', async () => {
  const cases: [string, unknown][] = [['denied', { status: 'denied' }], ['declined', { status: 'declined' }], ['unavailable', { status: 'unavailable' }],
    ['conflict', { status: 'expired' }], ['conflict', { status: 'conflict' }]];
  for (const [expected, offer] of cases) {
    const result = await fixture({ offer }).service.create(request());
    assert.equal(result.status === 'denied' ? result.error : result.status, expected === 'denied' ? 'consent_required' : expected);
  }
  assert.equal((await fixture({ offer: { status: 'replayed', offer: offerFixture().terms } }).service.create(request())).status, 'replayed');
});

const offerView = partnerOfferView(offerFixture().terms, offerFixture().capture);
function httpFixture(service: Pick<AdvisorOffers, 'create'>) {
  const app = createHttp({ quotes: {} as never, estimates: {} as never, advisorOffers: service as AdvisorOffers });
  return (init: RequestInit = {}, path = '/api/v1/advisor/offers') => app.request('http://localhost' + path, { method: 'POST', ...init, headers: { 'content-type': 'application/json', ...init.headers } }, { APP_ENV: 'local' } as never);
}

test('HTTP: only POST with the advisor session cookie reaches the use case, and a bearer token is rejected', async () => {
  const seen: { session: unknown; body: unknown; idempotencyKey: string | null; traceId: string }[] = [];
  const call = httpFixture({ create: async input => { seen.push(input); return { status: 'created', offer: offerView }; } });
  const trace = randomUUID();
  const response = await call({ body: JSON.stringify({ authorizationId }), headers: { cookie: 'solventa-session=sealed', origin: 'http://localhost', 'idempotency-key': 'k1', 'x-trace-id': trace } });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-trace-id'), trace);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(seen[0].session, { cookie: 'sealed', origin: 'http://localhost', requestOrigin: 'http://localhost', method: 'POST' });
  assert.deepEqual([seen[0].body, seen[0].idempotencyKey], [{ authorizationId }, 'k1']);
  const bearer = await call({ body: '{}', headers: { authorization: 'Bearer abc.def.ghi' } });
  assert.equal(bearer.status, 400);
  assert.equal(seen.length, 1, 'a partner token never reaches the advisor use case');
  const get = await call({ method: 'GET' });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
});

test('HTTP: results map to precise statuses and bodies', async () => {
  const outcomes: [Awaited<ReturnType<AdvisorOffers['create']>>, number, string | undefined][] = [
    [{ status: 'replayed', offer: offerView }, 200, undefined], [{ status: 'denied', error: 'unauthorized', httpStatus: 401 }, 401, 'unauthorized'],
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

test('HTTP: every attempt logs one profiling line for the advisor channel, with no customer data', async () => {
  const lines: string[] = []; const log = console.log;
  console.log = (line: string) => { lines.push(line); };
  try {
    await httpFixture({ create: async () => ({ status: 'created', offer: offerView }) })({ body: '{}' });
    await httpFixture({ create: async () => ({ status: 'denied', error: 'forbidden', httpStatus: 403 }) })({ body: '{}' });
  } finally { console.log = log; }
  const events = lines.filter(line => line.includes('mortgage_offer_profiled')).map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => [event.channel, event.result]), [['advisor', 'created'], ['advisor', 'denied']]);
  assert.equal(JSON.stringify(events).includes(customer.clientId), false);
});

test('the Identity adapter validates the untrusted reply, drops oversized cookies and bounds the call by its deadline', async () => {
  const sent: unknown[] = [];
  const identity = (reply: unknown, delay = 0) => new IdentityAdvisorSaleAccess({ authorizeAdvisorSaleV1: async request => { sent.push(request); await new Promise(resolve => setTimeout(resolve, delay)); return reply; } }, 30);
  const input = { session, authorizationId, traceId: randomUUID() };
  const good = { allowed: true, advisorReference, customer, consent, authorizationExpiresAt: '2026-11-10T12:00:00.000Z' };
  assert.deepEqual(await identity(good).authorize(input), allowed());
  assert.deepEqual(sent[0], { kind: 'web', cookie: session.cookie, origin: session.origin, requestOrigin: session.requestOrigin, method: 'POST', authorizationId, traceId: input.traceId });
  const unavailable = { allowed: false, error: 'access_unavailable', status: 503 };
  for (const reply of [null, 'ok', {}, { allowed: true }, { ...good, advisorReference: 'x' }, { ...good, customer: { ...customer, clientId: 'x' } }, { ...good, consent: { ...consent, consentId: 'CNS-1' } },
    { ...good, consent: { ...consent, textVersion: 0 } }, { ...good, consent: { ...consent, expiresAt: 'later' } }, { ...good, authorizationExpiresAt: 'soon' },
    { allowed: false, error: 'invalid_request', status: 400 }, { allowed: false, error: 'forbidden', status: 401 }, { allowed: false, status: 500 }]) {
    assert.deepEqual(await identity(reply).authorize(input), unavailable, JSON.stringify(reply));
  }
  assert.deepEqual(await identity({ allowed: false, error: 'unauthorized', status: 401 }).authorize(input), { allowed: false, error: 'unauthorized', status: 401 });
  assert.deepEqual(await identity({ allowed: false, error: 'consent_required', status: 403 }).authorize(input), { allowed: false, error: 'consent_required', status: 403 });
  assert.deepEqual(await identity(good, 200).authorize(input), unavailable, 'a slow Identity blocks the offer');
  sent.length = 0;
  await identity(good).authorize({ ...input, session: { ...session, cookie: 'x'.repeat(17000) } });
  assert.equal((sent[0] as { cookie: string }).cookie, '');
  const failing = new IdentityAdvisorSaleAccess({ authorizeAdvisorSaleV1: async () => { throw Error('binding closed'); } });
  assert.deepEqual(await failing.authorize(input), unavailable);
});
