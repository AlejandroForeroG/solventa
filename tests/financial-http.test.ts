import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { DependencyTimings } from '../backend/acquisition-risk/src/application/dependency-timings';
import { mountOffers, type OffersHttpDependencies } from '../backend/acquisition-risk/src/adapters/inbound/offers-http';
import { createHttp as createPolicyHttp, type PolicyHttpDependencies } from '../backend/policy-claims-payments/src/adapters/inbound/http';
import type { OfferTerms } from '../backend/acquisition-risk/src/domain/offer';
import type { PolicyView } from '../backend/policy-claims-payments/src/domain/financial';
import gateway from '../apps/web/worker/index';
import { readFileSync } from 'node:fs';
import { PolicyFinance } from '../backend/policy-claims-payments/src/application/policy-finance';
import { financialIntegrity, financialNow } from './financial-fixtures';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
for (const name of ['common', 'offers', 'policies']) ajv.addSchema({ ...parse(readFileSync(`packages/contracts/openapi/v1/${name}.yaml`, 'utf8')), $id: `https://solventa.test/v1/${name}.yaml` });
async function contractual(response: Response, domain: string, schema: string) {
  const body = await response.json();
  const check = ajv.getSchema(`https://solventa.test/v1/${domain}.yaml#/components/schemas/${schema}`);
  assert.ok(check);
  assert.equal(check(body), true, JSON.stringify(check.errors));
  return body as Record<string, unknown>;
}

const id = '10000000-0000-4000-8000-000000000001';
const traceId = '50000000-0000-4000-8000-000000000001';
const actor = { clientId: '30000000-0000-4000-8000-000000000001', subjectToken: '40000000-0000-4000-8000-000000000001' };
const consent = { consentId: 'CNS-2026-00001', textVersion: 2, expiresAt: '2027-01-01T00:00:00.000Z' };
const terms: OfferTerms = { ...actor, offerId: id, offerVersion: 1, quoteId: 'COT-2026-00001', product: 'vida_hipotecario', premium: '77760.0000', currency: 'COP', coverage: { kind: 'mortgage_life', sumInsured: '320000000.0000' }, effectiveFrom: '2026-10-15T00:00:00.000Z', effectiveUntil: '2027-10-15T00:00:00.000Z', expiresAt: '2026-10-15T00:15:00.000Z', ruleVersion: 'academic-mortgage-1', synthetic: true, status: 'definitive' };
const policy: PolicyView = { policyId: id, offerId: id, offerVersion: 1, status: 'pending', premium: '77760.0000', currency: 'COP', effectiveFrom: terms.effectiveFrom, effectiveUntil: terms.effectiveUntil, document: '{"synthetic":true}', documentHash: 'a'.repeat(64), synthetic: true, providerMode: 'mock' };
const acceptance = { acceptanceId: id, offerId: id, eventId: id, acceptedAt: '2026-10-15T00:01:00.000Z', status: 'pending_issuance' as const, synthetic: true as const };
const unexpected = async (): Promise<never> => { throw new Error('unexpected_provider_call'); };
const request = (path: string, body: string | undefined = '{}', headers: Record<string, string> = {}, method = 'POST') => new Request('https://web.example/api/v1' + path, { method, ...(body !== undefined && method !== 'GET' ? { body } : {}), headers: { 'content-type': 'application/json', cookie: 'solventa-session=synthetic-sealed', origin: 'https://web.example', 'idempotency-key': 'synthetic-operation-1', 'x-trace-id': traceId, ...headers } });

function setup(decision?: unknown, denialResult: unknown = { recorded: true }) {
  const calls: { operation: string; input: unknown }[] = [];
  const authorizeFinancialAccess = async (input: unknown) => {
    calls.push({ operation: 'authorize', input });
    if (decision) return decision;
    const operation = (input as { operation: string }).operation;
    return { allowed: true, actor: { kind: 'user', channel: 'web', principal: actor, operations: [operation] }, consent };
  };
  const offers: OffersHttpDependencies['offers'] = {
    create: async input => { calls.push({ operation: 'create', input }); return { status: 'created', offer: terms }; },
    createFlight: async input => { calls.push({ operation: 'createFlight', input }); return { status: 'created', offer: terms }; },
    get: async input => { calls.push({ operation: 'get', input }); return { status: 'found', offer: terms }; },
    accept: async input => { calls.push({ operation: 'accept', input }); return { status: 'created', acceptance }; },
  };
  const denyResourceAccess = async (input: unknown) => { calls.push({ operation: 'securityDenial', input }); if (denialResult instanceof Error) throw denialResult; return denialResult; };
  const app = new Hono<{ Bindings: AcquisitionEnv }>();
  mountOffers(app, { offers, authorizeFinancialAccess, denyResourceAccess });
  const finance: PolicyHttpDependencies['finance'] = {
    get: async input => { calls.push({ operation: 'policyGet', input }); return { status: 'ok', replayed: false, policy }; },
    getByAcceptance: async input => { calls.push({ operation: 'policyGetByAcceptance', input }); return { status: 'ok', replayed: false, policy }; },
    issue: async input => { calls.push({ operation: 'issue', input }); return { status: 'ok', replayed: false, policy: { ...policy, status: 'issued' } }; },
  };
  const policyApp = createPolicyHttp({ authorizeFinancialAccess, denyResourceAccess, finance });
  const run = (req: Request, policyRoute = false) => (policyRoute ? policyApp : app).fetch(req, { APP_ENV: 'local' } as never);
  return { calls, run, offers, finance };
}

test('offer creation uses one authorization, real Origin and server-derived actor/consent', async () => {
  const { calls, run } = setup();
  const response = await run(request('/quotes/COT-2026-00001/offers'));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-trace-id'), traceId);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await contractual(response, 'offers', 'Offer');
  assert.ok(!('clientId' in body) && !('subjectToken' in body));
  assert.deepEqual(calls.map(c => c.operation), ['authorize', 'create']);
  assert.deepEqual(calls[0].input, { kind: 'web', operation: 'offers:create', traceId, cookie: 'synthetic-sealed', origin: 'https://web.example', method: 'POST', requestOrigin: 'https://web.example' });
  const { timings, ...created } = calls[1].input as { timings: unknown };
  assert.ok(timings instanceof DependencyTimings, 'the use case receives the request timings');
  assert.deepEqual(created, { actor, quoteId: 'COT-2026-00001', idempotencyKey: 'synthetic-operation-1', authorization: consent, traceId });
});

test('financial authorization binds Origin to the actual destination for primary and retained hosts', async () => {
  for (const host of ['https://dev.solventa.site', 'https://solventa-web-dev.ja-forerog1.workers.dev']) {
    for (const policyRoute of [false, true]) {
      const {calls, run} = setup({allowed:false,status:403,error:'forbidden'});
      const path = policyRoute ? `/policies/${id}/issue` : '/quotes/COT-2026-00001/offers';
      const req = new Request(host + '/api/v1' + path, {method:'POST',body:'{}',headers:{origin:'https://foreign.invalid'}});
      assert.equal((await run(req, policyRoute)).status,403);
      assert.equal((calls[0].input as {requestOrigin:string}).requestOrigin,host);
      assert.equal((calls[0].input as {origin:string}).origin,'https://foreign.invalid');
      assert.equal(calls.length,1);
    }
  }
});

test('all financial writes reject client-selected money, actor or approval without calling business logic', async () => {
  for (const [path, body, policyRoute] of [
    ['/quotes/COT-2026-00001/offers', '{"approved":true}', false],
    [`/offers/${id}/accept`, '{"premium":"1.0000"}', false],
    ['/offers', `{"product":"flight_delay","flightReference":"${id}","payoutAmount":"1.0000"}`, false],
    [`/policies/${id}/issue`, `{"documentHash":"${'a'.repeat(64)}","clientId":"foreign"}`, true],
  ] as const) {
    const { calls, run } = setup();
    const response = await run(request(path, body), policyRoute);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_request', traceId });
    assert.deepEqual(calls.map(c => c.operation), ['authorize']);
  }
});

test('missing consent, revoked session and technical authorization failure stop all business work', async () => {
  for (const [status, error] of [[401, 'unauthorized'], [403, 'consent_required'], [503, 'access_unavailable']] as const) {
    const { calls, run } = setup({ allowed: false, status, error });
    const response = await run(request('/quotes/COT-2026-00001/offers'));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error, traceId });
    assert.deepEqual(calls.map(c => c.operation), ['authorize']);
  }
});

test('partner Authorization cannot be mixed into a web financial request', async () => {
  const { calls, run } = setup();
  assert.equal((await run(request(`/policies/${id}/issue`, '{}', { authorization: 'Bearer synthetic-token' }), true)).status, 400);
  assert.equal(calls.length, 0);
});

test('malformed or mismatched authorization reply cannot select a principal or permission', async () => {
  for (const user of [{ kind: 'partner', partnerId: id }, { kind: 'user', channel: 'mobile', principal: actor, operations: ['offers:create'] }, { kind: 'user', channel: 'web', principal: actor, operations: ['policies:read'] }]) {
    const { calls, run } = setup({ allowed: true, actor: user, consent });
    assert.equal((await run(request('/quotes/COT-2026-00001/offers'))).status, 503);
    assert.deepEqual(calls.map(c => c.operation), ['authorize']);
  }
});

test('oversized streamed body and non-JSON media never reach the financial use case', async () => {
  for (const [body, headers] of [[' '.repeat(1025), {}], ['{}', { 'content-type': 'text/plain' }]] as const) {
    const { calls, run } = setup();
    assert.equal((await run(request('/quotes/COT-2026-00001/offers', body, headers))).status, 400);
    assert.deepEqual(calls.map(c => c.operation), ['authorize']);
  }
});

test('acceptance returns 202 pending asynchronous issuance, and issue requires the reviewed document hash', async () => {
  const { calls, run } = setup();
  const accepted = await run(request(`/offers/${id}/accept`));
  assert.equal(accepted.status, 202);
  await contractual(accepted, 'offers', 'Acceptance');
  const found = await run(request(`/policies/by-acceptance/${id}/policy`, undefined, {}, 'GET'), true);
  assert.equal(found.status, 200);
  assert.equal((await contractual(found, 'policies', 'Policy')).policyId, id);
  assert.deepEqual(calls.find(c => c.operation === 'policyGetByAcceptance')?.input, { actor, acceptanceId: id, traceId });
  const response = await run(request(`/policies/${id}/issue`, JSON.stringify({ documentHash: policy.documentHash })), true);
  assert.equal(response.status, 200);
  assert.equal((await contractual(response, 'policies', 'Policy')).status, 'issued');
  assert.deepEqual(calls.find(c => c.operation === 'issue')?.input, { actor, policyId: id, idempotencyKey: 'synthetic-operation-1', documentHash: policy.documentHash, traceId });
});

test('financial routes reach only their owner and retain credentials and safe failure traces', async () => {
  for (const [path, owner] of [[`/offers/${id}`, 'acquisition'], [`/policies/${id}`, 'policy']] as const) {
    const calls: string[] = [];
    const env = { APP_ENV: 'local', ACQUISITION: { fetch: async (req: Request) => { calls.push('acquisition'); assert.equal(req.headers.get('cookie'), 'solventa-session=synthetic-sealed'); return Response.json({ ok: true }); } }, POLICY: { fetch: async () => { calls.push('policy'); throw Error('secret synthetic provider data'); } } } as never;
    const response = await gateway.fetch(request(path, undefined, {}, 'GET'), env);
    assert.deepEqual(calls, [owner]);
    if (owner === 'policy') { assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'financial_unavailable', traceId }); }
  }
});

test('UUID casing is normalized before owner lookup and cannot select a separate resource', async () => {
  const resource = 'abcdefab-0000-4000-8000-abcdefabcdef';
  const principal = { clientId: resource.toUpperCase(), subjectToken: resource.toUpperCase() };
  const { calls, run } = setup({ allowed: true, actor: { kind: 'user', channel: 'web', principal, operations: ['policies:read'] } });
  assert.equal((await run(request(`/policies/${resource.toUpperCase()}`, undefined, {}, 'GET'), true)).status, 200);
  assert.deepEqual(calls.find(c => c.operation === 'policyGet')?.input, { actor: { clientId: resource, subjectToken: resource }, policyId: resource, traceId });
});

test('opaque financial resource rejection records only operation and trace before returning 404', async () => {
  const { calls, run, offers, finance } = setup();
  offers.get = async () => ({ status: 'not_found' });
  finance.get = async () => ({ status: 'denied', error: 'not_found', httpStatus: 404, traceId });
  for (const [path, policyRoute, operation] of [[`/offers/${id}`, false, 'offers:read'], [`/policies/${id}`, true, 'policies:read']] as const) {
    const response = await run(request(path, undefined, {}, 'GET'), policyRoute);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not_found', traceId });
    assert.deepEqual(calls.at(-1), { operation: 'securityDenial', input: { operation, traceId } });
  }
});

test('a denied mortgage acceptance is recorded and an unavailable denial audit fails closed as 503', async () => {
  for (const result of [{ recorded: true }, { recorded: false, error: 'access_unavailable' }, new Error('synthetic private failure')]) {
    const { calls, run, offers } = setup(undefined, result);
    offers.accept = async () => ({ status: 'denied' });
    const response = await run(request(`/offers/${id}/accept`));
    const successfulAudit = !(result instanceof Error) && result.recorded;
    assert.equal(response.status, successfulAudit ? 403 : 503);
    assert.deepEqual(await response.json(), { error: successfulAudit ? 'consent_required' : 'access_unavailable', traceId });
    assert.deepEqual(calls.at(-1), { operation: 'securityDenial', input: { operation: 'offers:accept', traceId } });
  }
});

test('both financial owners cancel unread bodies before returning early denials, method errors and read responses', async () => {
  for (const policyRoute of [false, true]) for (const outcome of ['denied', 'method', 'mixed', 'read'] as const) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"unfinished":')); }, cancel() { cancelled = true; } });
    const path = policyRoute ? `/policies/${id}${outcome === 'read' ? '' : '/issue'}` : outcome === 'read' ? `/offers/${id}` : '/quotes/COT-2026-00001/offers';
    const init: RequestInit & { duplex: 'half' } = { method: outcome === 'method' ? 'PUT' : 'POST', body, duplex: 'half', headers: { 'x-trace-id': traceId, ...(outcome === 'mixed' ? { authorization: 'Bearer synthetic-token' } : {}) } };
    const req = new Request('https://web.example/api/v1' + path, init);
    // Node's constructor disallows GET bodies; Workers can receive such an HTTP request.
    // Keep a real transport stream and set only the fixture's received method.
    if (outcome === 'read') Object.defineProperty(req, 'method', { value: 'GET' });
    const { run } = setup(outcome === 'denied' ? { allowed: false, status: 401, error: 'unauthorized' } : undefined);
    const response = await run(req, policyRoute);
    assert.equal(response.status, outcome === 'denied' ? 401 : outcome === 'method' ? 405 : outcome === 'mixed' ? 400 : 200);
    assert.equal(cancelled, true, `${policyRoute ? 'policy' : 'offer'} ${outcome}`);
  }
});

test('offer reads pass the original trace to core integrity auditing and map an unavailable audit to 503', async () => {
  for (const status of ['integrity_invalid', 'unavailable'] as const) {
    const { calls, run, offers } = setup();
    offers.get = async input => { calls.push({ operation: 'get', input }); return { status }; };
    const response = await run(request(`/offers/${id}`, undefined, {}, 'GET'));
    assert.equal(response.status, status === 'integrity_invalid' ? 409 : 503);
    assert.deepEqual(await response.json(), { error: status === 'integrity_invalid' ? status : 'financial_unavailable', traceId });
    assert.deepEqual(calls.find(c => c.operation === 'get')?.input, { actor, offerId: id, traceId });
  }
});

test('a pending acceptance read returns the opaque 404 without a security denial, while a foreign policy still records one', async () => {
  const { calls, run, finance } = setup();
  finance.getByAcceptance = async input => { calls.push({ operation: 'policyGetByAcceptance', input }); return { status: 'denied', error: 'policy_pending', httpStatus: 404, traceId }; };
  const pending = await run(request(`/policies/by-acceptance/${id}/policy`, undefined, {}, 'GET'), true);
  assert.equal(pending.status, 404);
  assert.deepEqual(await contractual(pending, 'policies', 'Error'), { error: 'not_found', traceId });
  assert.deepEqual(calls.map(c => c.operation), ['authorize', 'policyGetByAcceptance']);
  finance.getByAcceptance = async () => ({ status: 'denied', error: 'not_found', httpStatus: 404, traceId });
  const foreign = await run(request(`/policies/by-acceptance/${id}/policy`, undefined, {}, 'GET'), true);
  assert.equal(foreign.status, 404);
  assert.deepEqual(await foreign.json(), { error: 'not_found', traceId });
  assert.equal(calls.filter(c => c.operation === 'securityDenial').length, 1);
});

test('composed acceptance reads keep one opaque 404 but record a security denial only for an existing foreign acceptance', async () => {
  const bodies: unknown[] = [];
  for (const [lookup, rejections, denials] of [[{ status: 'absent' }, 0, 0], [{ status: 'foreign' }, 1, 1]] as const) {
    const { calls } = setup();
    let rejected = 0;
    const finance = new PolicyFinance({ enabled: true, environment: 'local', integrity: financialIntegrity, now: financialNow, newId: () => crypto.randomUUID(),
      store: { async readPolicy() { throw new Error('unexpected_policy_read'); }, async readAcceptedPolicy() { return lookup; },
        async importAcceptance() { throw new Error('unexpected_import'); }, async transaction() { throw new Error('unexpected_transaction'); }, async rejection() { rejected++; } },
      payments: { lookup: unexpected, settle: unexpected, refund: unexpected }, signatures: { sign: unexpected } });
    const app = createPolicyHttp({ finance,
      authorizeFinancialAccess: async input => ({ allowed: true, actor: { kind: 'user', channel: 'web', principal: actor, operations: [(input as { operation: string }).operation] }, consent }),
      denyResourceAccess: async input => { calls.push({ operation: 'securityDenial', input }); return { recorded: true }; } });
    const response = await app.fetch(request(`/policies/by-acceptance/${id}/policy`, undefined, {}, 'GET'), { APP_ENV: 'local' } as never);
    assert.equal(response.status, 404);
    bodies.push(await contractual(response, 'policies', 'Error'));
    assert.equal(rejected, rejections);
    assert.deepEqual(calls.filter(c => c.operation === 'securityDenial').map(c => c.input), denials ? [{ operation: 'policies:read', traceId }] : []);
  }
  assert.deepEqual(bodies, [{ error: 'not_found', traceId }, { error: 'not_found', traceId }]);
});

test('foreign acceptance discovery fails closed when either required denial audit is unavailable', async () => {
  for (const failedOwner of ['policy', 'identity']) {
    let securityCalls = 0;
    const finance = new PolicyFinance({ enabled: true, environment: 'local', integrity: financialIntegrity, now: financialNow, newId: () => crypto.randomUUID(),
      store: { async readPolicy() { throw new Error('unexpected_policy_read'); }, async readAcceptedPolicy() { return { status: 'foreign' }; },
        async importAcceptance() { throw new Error('unexpected_import'); }, async transaction() { throw new Error('unexpected_transaction'); },
        async rejection() { if (failedOwner === 'policy') throw new Error('synthetic_audit_failure'); } },
      payments: { lookup: unexpected, settle: unexpected, refund: unexpected }, signatures: { sign: unexpected } });
    const app = createPolicyHttp({ finance,
      authorizeFinancialAccess: async () => ({ allowed: true, actor: { kind: 'user', channel: 'web', principal: actor, operations: ['policies:read'] } }),
      denyResourceAccess: async () => { securityCalls++; return { recorded: false, error: 'access_unavailable' }; } });
    const response = await app.fetch(request(`/policies/by-acceptance/${id}/policy`, undefined, {}, 'GET'), { APP_ENV: 'local' } as never);
    assert.equal(response.status, 503);
    assert.deepEqual(await contractual(response, 'policies', 'Error'), { error: failedOwner === 'policy' ? 'financial_unavailable' : 'access_unavailable', traceId });
    assert.equal(securityCalls, failedOwner === 'policy' ? 0 : 1);
  }
});

test('only a newly committed acceptance starts publication of its own event, without changing the response', async () => {
  for (const [status, expected, published] of [['created', 202, [id]], ['replayed', 200, []]] as const) {
    const started: string[] = [];
    const app = new Hono<{ Bindings: AcquisitionEnv }>();
    mountOffers(app, { authorizeFinancialAccess: async input => ({ allowed: true, actor: { kind: 'user', channel: 'web', principal: actor, operations: [(input as { operation: string }).operation] }, consent }),
      denyResourceAccess: async () => ({ recorded: true }),
      offers: { create: async () => ({ status: 'created', offer: terms }), createFlight: async () => ({ status: 'created', offer: terms }), get: async () => ({ status: 'found', offer: terms }),
        accept: async () => ({ status, acceptance }) },
      acceptanceCommitted: eventId => { started.push(eventId); throw new Error('scheduling failure must not change the committed answer'); } });
    const response = await app.fetch(request(`/offers/${id}/accept`), { APP_ENV: 'local' } as never);
    assert.equal(response.status, expected);
    await contractual(response, 'offers', 'Acceptance');
    assert.deepEqual(started, published);
  }
});

test('the profiling log line names the slowest dependency and lists every timed call without personal data', async () => {
  const lines: string[] = [];
  const log = mock.method(console, 'log', (line: string) => { lines.push(line); });
  try {
    const app = new Hono<{ Bindings: AcquisitionEnv }>();
    mountOffers(app, { authorizeFinancialAccess: async input => ({ allowed: true, actor: { kind: 'user', channel: 'web', principal: actor, operations: [(input as { operation: string }).operation] }, consent }),
      denyResourceAccess: async () => ({ recorded: true }),
      offers: { create: async input => { input.timings?.record('provider:payment_history_score', 90, 'ok'); input.timings?.record('offer_write', 12, 'ok'); return { status: 'created', offer: terms }; },
        createFlight: async () => ({ status: 'created', offer: terms }), get: async () => ({ status: 'found', offer: terms }), accept: async () => { throw new Error('unexpected_accept'); } } });
    const response = await app.fetch(request('/quotes/COT-2026-00001/offers', '{}', { 'idempotency-key': 'profile-1', 'x-trace-id': traceId }), { APP_ENV: 'local' } as never);
    assert.equal(response.status, 201);
  } finally { log.mock.restore(); }
  const line = JSON.parse(lines.find(candidate => candidate.includes('mortgage_offer_profiled')) ?? '{}');
  assert.equal(line.dominant, 'provider:payment_history_score');
  assert.deepEqual(line.dependencies.map((call: { name: string }) => call.name), ['identity_access', 'provider:payment_history_score', 'offer_write']);
  assert.deepEqual(Object.keys(line).sort(), ['dependencies', 'dominant', 'event', 'latencyMs', 'offerStatus', 'result', 'traceId']);
});

test('profiling includes failed SQL reads and writes without changing the unavailable response', async t => {
  for (const name of ['offer_read', 'offer_write']) await t.test(name, async t => {
    const lines: string[] = [];
    t.mock.method(console, 'log', (line: string) => { lines.push(line); });
    const { run, offers } = setup();
    offers.create = async input => input.timings!.measure(name, async () => { throw new Error('private SQL detail'); });
    const response = await run(request('/quotes/COT-2026-00001/offers'));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'financial_unavailable', traceId });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-trace-id'), traceId);
    const profiles = lines.map(line => JSON.parse(line)).filter(line => line.event === 'mortgage_offer_profiled');
    assert.equal(profiles.length, 1);
    const profile = profiles[0];
    assert.equal(profile.result, 'unavailable');
    assert.equal(profile.offerStatus, null);
    assert.equal(profile.traceId, traceId);
    assert.deepEqual(profile.dependencies.map((call: { name: string; outcome: string }) => [call.name, call.outcome]), [['identity_access', 'ok'], [name, 'failed']]);
    assert.ok(profile.dependencies.some((call: { name: string }) => call.name === profile.dominant));
    for (const privateValue of [actor.clientId, actor.subjectToken, consent.consentId, 'synthetic-sealed', 'private SQL detail']) assert.ok(!JSON.stringify(profile).includes(privateValue));
  });
});

test('profiling includes authorization rejection, failure and its observed deadline', async t => {
  for (const mode of ['denied', 'failed', 'timeout'] as const) await t.test(mode, async t => {
    const lines: string[] = [];
    t.mock.method(console, 'log', (line: string) => { lines.push(line); });
    if (mode === 'timeout') t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { offers } = setup();
    offers.create = unexpected;
    const app = new Hono<{ Bindings: AcquisitionEnv }>();
    mountOffers(app, { offers, denyResourceAccess: unexpected, authorizeFinancialAccess: async () => {
      if (mode === 'denied') return { allowed: false, status: 403, error: 'consent_required' };
      if (mode === 'failed') throw new Error('private Identity detail');
      return new Promise(() => {});
    } });
    const pending = app.fetch(request('/quotes/COT-2026-00001/offers'), { APP_ENV: 'local' } as never);
    if (mode === 'timeout') t.mock.timers.tick(2000);
    const response = await pending;
    assert.equal(response.status, mode === 'denied' ? 403 : 503);
    assert.deepEqual(await response.json(), { error: mode === 'denied' ? 'consent_required' : 'financial_unavailable', traceId });
    const profiles = lines.map(line => JSON.parse(line)).filter(line => line.event === 'mortgage_offer_profiled');
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].result, mode === 'denied' ? 'denied' : 'unavailable');
    assert.equal(profiles[0].offerStatus, null);
    assert.equal(profiles[0].dominant, 'identity_access');
    assert.equal(profiles[0].dependencies.length, 1);
    assert.equal(profiles[0].dependencies[0].outcome, mode === 'denied' ? 'ok' : 'failed');
    if (mode === 'timeout') assert.equal(profiles[0].dependencies[0].durationMs, 2000);
    assert.ok(!JSON.stringify(profiles[0]).includes('private Identity detail'));
  });
});

test('profiling waits for a failed security denial audit and records the final unavailable result', async t => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => { lines.push(line); });
  const { run, offers } = setup(undefined, new Error('private audit detail'));
  offers.create = async () => ({ status: 'not_found' });
  const response = await run(request('/quotes/COT-2026-00001/offers'));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'access_unavailable', traceId });
  const profiles = lines.map(line => JSON.parse(line)).filter(line => line.event === 'mortgage_offer_profiled');
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].result, 'unavailable');
});
