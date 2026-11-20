import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Hono } from 'hono';
import { parse } from 'yaml';
import { mountNotices } from '../backend/policy-claims-payments/src/adapters/inbound/notices-http';
import { ExpiryNotices, EXPIRY_WINDOW_MS } from '../backend/policy-claims-payments/src/application/expiry-notices';
import { Notices, type PushChoices } from '../backend/policy-claims-payments/src/application/notices';
import type { NoticeStore } from '../backend/policy-claims-payments/src/application/ports/notice';
import { claimNoticeFrom, dispatchConsumer, noticeFrom, type Notice } from '../backend/policy-claims-payments/src/domain/notice';
import { memoryNoticeStore } from './support/notice-fakes';

const A = '10000000-0000-4000-8000-00000000000a';
const B = '10000000-0000-4000-8000-00000000000b';
const policyId = '60000000-0000-4000-8000-000000000001';
const trace = '30000000-0000-4000-8000-000000000001';
const event = (n: number) => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const on: PushChoices = { policy: true, payments: true, claims: false, commercial: false };
const off: PushChoices = { policy: false, payments: false, claims: false, commercial: false };

const memoryStore = (seed: { owner: string; notice: Notice }[]) => memoryNoticeStore(seed, clock);
const clock = { current: new Date('2026-11-18T12:00:00.000Z'), now() { return this.current; } };
const notice = (n: number, kind: Notice['kind'] = 'parametric_payment_confirmed'): Notice => ({ eventId: event(n), kind, category: kind === 'parametric_payment_confirmed' ? 'payments' : 'policy', policyId, occurredAt: '2026-11-18T11:00:00.000Z' });

const firstDevice = 'a1234567-1234-4123-8123-123456789abc';
const secondDevice = 'b1234567-1234-4123-8123-123456789abc';

test('denied permission on one installation does not consume another installation delivery', async () => {
  const { store } = memoryStore([{ owner:A, notice:notice(1) }]);
  const service = new Notices(store, clock);
  const first = { clientId:A, destination:firstDevice }, second = { clientId:A, destination:secondDevice };
  await service.list(first, on, trace);
  assert.deepEqual(await service.receipt(first, event(1), 'permission_denied', trace), { status:'recorded', state:'permission_denied' });
  assert.equal((await service.list(second, on, trace))[0]?.state, 'offered');
  assert.deepEqual(await service.receipt(second, event(1), 'presented', trace), { status:'recorded', state:'presented' });
  assert.equal((await service.list(first, on, trace))[0]?.state, 'permission_denied');
  assert.equal((await service.list(second, on, trace))[0]?.state, 'presented');
});

test('concurrent destinations keep independent receipts and concurrent same-destination retries replay', async () => {
  const { store } = memoryStore([{ owner:A, notice:notice(1) }]);
  const service = new Notices(store, clock);
  const first = { clientId:A, destination:firstDevice }, second = { clientId:A, destination:secondDevice };
  await Promise.all([service.list(first, on, trace), service.list(second, on, trace)]);
  const receipts = await Promise.all([service.receipt(first, event(1), 'presented', trace), service.receipt(first, event(1), 'presented', trace), service.receipt(second, event(1), 'permission_denied', trace)]);
  assert.deepEqual(receipts.map(result=>result.status).sort(), ['recorded','recorded','replayed']);
  assert.deepEqual(await service.receipt(first, event(1), 'permission_denied', trace), { status:'conflict' });
  assert.deepEqual(await service.receipt({ clientId:B, destination:firstDevice }, event(1), 'presented', trace), { status:'not_found' });
});

test('legacy global receipts remain historical and never become evidence for an unrecorded installation', async () => {
  const { store, inbox } = memoryStore([{ owner:A, notice:notice(1) }]);
  const service = new Notices(store, clock);
  await service.list({ clientId:A }, on, trace);
  await service.receipt({ clientId:A }, event(1), 'permission_denied', trace);
  const historical = [...inbox.entries()];
  assert.equal((await service.list({ clientId:A, destination:firstDevice }, on, trace))[0]?.state, 'offered');
  assert.equal((await service.list({ clientId:A }, on, trace))[0]?.state, 'permission_denied');
  for (const [key,value] of historical) assert.deepEqual(inbox.get(key), value);
});

test('a notice is offered when its choice is on, once, and the same list again records nothing new', async () => {
  const { store, writes } = memoryStore([{ owner: A, notice: notice(1) }]);
  const notices = new Notices(store, clock);
  const first = await notices.list({ clientId: A }, on, trace);
  assert.deepEqual(first.map(item => [item.eventId, item.kind, item.category, item.state]), [[event(1), 'parametric_payment_confirmed', 'payments', 'offered']]);
  assert.equal(Object.hasOwn(first[0]!, 'clientId'), false, 'the view carries no owner');
  await notices.list({ clientId: A }, on, trace);
  assert.deepEqual(writes, [`${dispatchConsumer}:offered`]);
});

test('a notice whose choice is off is recorded as suppressed, never offered, and turning the choice on later does not release it', async () => {
  const { store, writes } = memoryStore([{ owner: A, notice: notice(1) }, { owner: A, notice: notice(2, 'policy_lifecycle_changed') }]);
  const notices = new Notices(store, clock);
  assert.deepEqual(await notices.list({ clientId: A }, { ...on, payments: false }, trace).then(list => list.map(item => item.category)), ['policy']);
  assert.deepEqual(writes, [`${dispatchConsumer}:suppressed_preference`, `${dispatchConsumer}:offered`]);
  assert.deepEqual(await notices.list({ clientId: A }, on, trace).then(list => list.map(item => item.eventId)), [event(2)]);
});

test('a notice offered but not presented is withdrawn while its choice is off, and a presented one stays in the history', async () => {
  const { store } = memoryStore([{ owner: A, notice: notice(1) }, { owner: A, notice: notice(2, 'policy_lifecycle_changed') }]);
  const notices = new Notices(store, clock);
  await notices.list({ clientId: A }, on, trace);
  assert.equal((await notices.receipt({ clientId: A }, event(2), 'presented', trace)).status, 'recorded');
  assert.deepEqual(await notices.list({ clientId: A }, off, trace).then(list => list.map(item => [item.eventId, item.state])), [[event(2), 'presented']]);
  assert.deepEqual(await notices.list({ clientId: A }, on, trace).then(list => list.map(item => item.eventId)), [event(1), event(2)]);
});

test('a customer never sees, and cannot confirm, the notice of another customer', async () => {
  const { store, writes } = memoryStore([{ owner: B, notice: notice(1) }]);
  const notices = new Notices(store, clock);
  assert.deepEqual(await notices.list({ clientId: A }, on, trace), []);
  assert.deepEqual(await notices.receipt({ clientId: A }, event(1), 'presented', trace), { status: 'not_found' });
  assert.deepEqual(writes, []);
});

test('a receipt is one outcome per notice: the same report is a replay, another is a conflict, and an unoffered notice cannot be confirmed', async () => {
  const { store } = memoryStore([{ owner: A, notice: notice(1) }]);
  const notices = new Notices(store, clock);
  assert.deepEqual(await notices.receipt({ clientId: A }, event(1), 'presented', trace), { status: 'conflict' }, 'nothing was offered yet');
  await notices.list({ clientId: A }, on, trace);
  assert.deepEqual(await notices.receipt({ clientId: A }, event(1), 'permission_denied', trace), { status: 'recorded', state: 'permission_denied' });
  assert.deepEqual(await notices.receipt({ clientId: A }, event(1), 'permission_denied', trace), { status: 'replayed', state: 'permission_denied' });
  assert.deepEqual(await notices.receipt({ clientId: A }, event(1), 'presented', trace), { status: 'conflict' });
  // The notice that was never offered because its choice was off cannot be confirmed either.
  const suppressed = memoryStore([{ owner: A, notice: notice(3) }]);
  const quiet = new Notices(suppressed.store, clock);
  await quiet.list({ clientId: A }, off, trace);
  assert.deepEqual(await quiet.receipt({ clientId: A }, event(3), 'presented', trace), { status: 'conflict' });
});

test('an offer without a receipt becomes unconfirmed after ten minutes: presentation is uncertain, never assumed', async () => {
  const { store } = memoryStore([{ owner: A, notice: notice(1) }]);
  const notices = new Notices(store, clock);
  clock.current = new Date('2026-11-18T12:00:00.000Z');
  assert.equal((await notices.list({ clientId: A }, on, trace))[0]?.state, 'offered');
  clock.current = new Date('2026-11-18T12:09:00.000Z');
  assert.equal((await notices.list({ clientId: A }, on, trace))[0]?.state, 'offered');
  clock.current = new Date('2026-11-18T12:11:00.000Z');
  assert.equal((await notices.list({ clientId: A }, on, trace))[0]?.state, 'unconfirmed');
  clock.current = new Date('2026-11-18T12:00:00.000Z');
});

test('two concurrent lists agree on the decision that was stored first', async () => {
  const seed = [{ owner: A, notice: notice(1) }];
  const { store, inbox } = memoryStore(seed);
  // The other request decided "suppressed" between this request's read and its write.
  const racing: NoticeStore = { ...store, record: async (eventId, type, consumer, outcome, traceId) => {
    inbox.set(`${eventId}|${consumer}`, { outcome: 'suppressed_preference', at: clock.current });
    return store.record(eventId, type, consumer, outcome, traceId);
  } };
  assert.deepEqual(await new Notices(racing, clock).list({ clientId: A }, on, trace), []);
});

test('only a stored notice with the exact identity of its kind becomes a view', () => {
  const base = { eventId: event(1), createdAt: new Date('2026-11-18T11:00:00.000Z') };
  const payment = { category: 'parametric_payment_confirmed', clientId: A, policyId, paymentId: event(1) };
  assert.equal(noticeFrom({ ...base, eventType: 'policy.indemnity.notice', payload: payment })?.category, 'payments');
  assert.equal(noticeFrom({ ...base, eventType: 'policy.lifecycle.notice', payload: { category: 'policy_lifecycle_changed', clientId: A, policyId, action: 'renewed' } })?.category, 'policy');
  assert.equal(noticeFrom({ ...base, eventType: 'policy.indemnity.notice', payload: { ...payment, category: 'policy_lifecycle_changed' } }), null, 'a category that does not match its event type');
  assert.equal(noticeFrom({ ...base, eventType: 'policy.indemnity.notice', payload: { ...payment, policyId: 'not-a-uuid' } }), null);
  assert.equal(noticeFrom({ ...base, eventType: 'policy.parametric.accepted', payload: payment }), null, 'another event type is not a notice');
  assert.equal(noticeFrom({ ...base, eventType: 'policy.indemnity.notice', payload: 'text' }), null);
  assert.equal(noticeFrom({ ...base, eventId: 'x', eventType: 'policy.indemnity.notice', payload: payment }), null);
});

// ---- HTTP: the native customer only, the owner from the verified session, the choices from the same decision.
function http(options: { decide?: (input: { operation: string; token: string }) => unknown; owner?: string; records?: { owner: string; notice: Notice }[] } = {}) {
  const { store } = memoryStore(options.records ?? [{ owner: A, notice: notice(1) }]);
  const app = new Hono<{ Bindings: PolicyEnv }>();
  const calls: string[] = [];
  mountNotices(app, {
    authorize: async input => {
      calls.push(input.operation);
      return options.decide ? options.decide(input) : { allowed: true, actor: { kind: 'user', channel: 'mobile', principal: { clientId: options.owner ?? A, subjectToken: '20000000-0000-4000-8000-00000000000a' }, operations: [input.operation] }, pushChoices: on };
    },
    notices: new Notices(store, clock),
  });
  const request = (path: string, init: RequestInit = {}) => app.request(path, { headers: { authorization: 'Bearer synthetic.token', ...init.headers as Record<string, string> }, ...init, headers: { authorization: 'Bearer synthetic.token', ...init.headers as Record<string, string> } }, {} as PolicyEnv);
  return { request, calls };
}

test('v2 uses only Identity destination, isolates receipt state and rejects a caller-selected receipt destination', async () => {
  const { request } = http({ decide: input => ({ allowed:true, actor:{kind:'user',channel:'mobile',principal:{clientId:A,subjectToken:B},operations:[input.operation],noticeDestination:input.token === 'second.token' ? secondDevice : firstDevice}, pushChoices:on }) });
  const read = (token: string) => request('/api/v2/notices', { headers:{authorization:`Bearer ${token}`, 'x-notice-destination':secondDevice} });
  const receipt = (token: string, body: object) => request(`/api/v2/notices/${event(1)}/receipt`, {method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await read('first.token')).status, 200);
  const firstReceipt = await receipt('first.token',{outcome:'permission_denied'});
  assert.equal(firstReceipt.status, 200);
  assert.ok(validateReceipt(await firstReceipt.json()), JSON.stringify(validateReceipt.errors));
  const secondList = await read('second.token');
  const body = await secondList.json() as { notices: {state:string}[] };
  assert.ok(validateList(body), JSON.stringify(validateList.errors));
  assert.equal(body.notices[0]?.state,'offered');
  assert.equal((await receipt('second.token',{outcome:'presented',destination:firstDevice})).status,400);
  assert.equal((await receipt('second.token',{outcome:'presented'})).status,200);
});

test('v2 refuses a positive authorization without its verified destination while v1 stays compatible', async () => {
  const { request } = http();
  assert.equal((await request('/api/v2/notices')).status,503);
  assert.equal((await request(`/api/v2/notices/${event(1)}/receipt`,{method:'POST',headers:{'content-type':'application/json'},body:'{"outcome":"presented"}'})).status,503);
  assert.equal((await request('/api/v1/notices')).status,200);
});

test('the native list answers with the offered notices, marks the transport as simulated and hides the owner', async () => {
  const { request, calls } = http();
  const response = await request('/api/v1/notices');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json() as { simulated: boolean; notices: Record<string, unknown>[]; traceId: string };
  assert.equal(body.simulated, true);
  assert.deepEqual(body.notices.map(item => Object.keys(item).sort()), [['category', 'eventId', 'kind', 'occurredAt', 'policyId', 'state']]);
  assert.deepEqual(calls, ['notices:read']);
});

test('without a bearer token, with a cookie only or with the wrong method nothing is read', async () => {
  const { request, calls } = http();
  assert.equal((await request('/api/v1/notices', { headers: { authorization: '' } })).status, 401);
  assert.equal((await request('/api/v1/notices', { method: 'POST' })).status, 405);
  assert.equal((await request(`/api/v1/notices/${event(1)}/receipt`)).status, 405);
  assert.deepEqual(calls, []);
});

test('the list needs the choices of the same decision: without them nothing is offered', async () => {
  const withoutChoices = http({ decide: input => ({ allowed: true, actor: { kind: 'user', channel: 'mobile', principal: { clientId: A, subjectToken: '20000000-0000-4000-8000-00000000000a' }, operations: [input.operation] } }) });
  assert.equal((await withoutChoices.request('/api/v1/notices')).status, 503);
  const malformed = http({ decide: input => ({ allowed: true, actor: { kind: 'user', channel: 'mobile', principal: { clientId: A, subjectToken: '20000000-0000-4000-8000-00000000000a' }, operations: [input.operation] }, pushChoices: { policy: true } }) });
  assert.equal((await malformed.request('/api/v1/notices')).status, 503);
});

test('a denied, unavailable or inconsistent access decision never reaches the notices', async () => {
  for (const [decision, status] of [[{ allowed: false, error: 'unauthorized', status: 401 }, 401], [{ allowed: false, error: 'forbidden', status: 403 }, 403], [{ allowed: false, error: 'access_unavailable', status: 503 }, 503], [null, 503],
    [{ allowed: true, actor: { kind: 'user', channel: 'web', principal: { clientId: A }, operations: ['notices:read'] }, pushChoices: on }, 503],
    [{ allowed: true, actor: { kind: 'user', channel: 'mobile', principal: { clientId: 'not-a-uuid' }, operations: ['notices:read'] }, pushChoices: on }, 503]] as const) {
    const { request } = http({ decide: () => decision });
    assert.equal((await request('/api/v1/notices')).status, status, JSON.stringify(decision));
  }
});

test('the receipt takes exactly one known outcome, records it once and answers a repeat as a replay', async () => {
  const { request, calls } = http();
  await request('/api/v1/notices');
  const send = (body: unknown, path = `/api/v1/notices/${event(1)}/receipt`, type = 'application/json') =>
    request(path, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  assert.equal((await send({ outcome: 'bogus' })).status, 400);
  assert.equal((await send({ outcome: 'presented', extra: true })).status, 400);
  assert.equal((await send('{ not json')).status, 400);
  assert.equal((await send({ outcome: 'presented' }, undefined, 'text/plain')).status, 415);
  assert.equal((await send({ outcome: 'presented' }, '/api/v1/notices/not-a-uuid/receipt')).status, 404);
  assert.equal((await send({ outcome: 'presented' }, `/api/v1/notices/${event(9)}/receipt`)).status, 404);
  const first = await send({ outcome: 'presented' });
  assert.equal(first.status, 200);
  assert.deepEqual({ ...(await first.json() as object), traceId: undefined }, { eventId: event(1), state: 'presented', replayed: false, traceId: undefined });
  assert.equal(((await (await send({ outcome: 'presented' })).json()) as { replayed: boolean }).replayed, true);
  assert.equal((await send({ outcome: 'permission_denied' })).status, 409);
  assert.ok(calls.includes('notices:receipt'));
});

test('a receipt larger than its limit is refused before it is read', async () => {
  const { request } = http();
  const big = JSON.stringify({ outcome: 'presented', pad: 'x'.repeat(400) });
  const response = await request(`/api/v1/notices/${event(1)}/receipt`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(big.length) }, body: big });
  assert.equal(response.status, 400);
});

// ---- The contract and the answers agree.
const spec = parse(readFileSync('packages/contracts/openapi/v1/notices.yaml', 'utf8'));
const examples = JSON.parse(readFileSync('packages/contracts/examples/notices.json', 'utf8'));
const ajv = new Ajv({ strict: false });
addFormats(ajv);
const schema = (name: string) => ajv.compile({ ...spec.components.schemas[name], components: spec.components });
const validateList = schema('NoticeList');
const validateReceipt = schema('NoticeReceipt');
const validateBody = schema('NoticeReceiptBody');
const validateError = schema('Error');
const validateDecisionCapture = ajv.compile(JSON.parse(readFileSync('packages/contracts/schemas/decision-capture.v1.json','utf8')));

test('v2 retains actual destination, preference and reported outcome in schema-valid captures without duplicate replay captures',async()=>{
  const {store,captures} = memoryStore([{owner:A,notice:notice(1)}]);
  const service = new Notices(store,clock), owner = {clientId:A,destination:firstDevice};
  await service.list(owner,on,trace);
  await service.receipt(owner,event(1),'permission_denied',trace);
  await service.receipt(owner,event(1),'permission_denied',trace);
  assert.equal(captures.length,2);
  for(const capture of captures) { assert.ok(validateDecisionCapture(capture),JSON.stringify(validateDecisionCapture.errors)); assert.equal(capture.inputs.destination,firstDevice); }
  assert.equal(captures[0]!.inputs.pushEnabled,true);
  assert.equal(captures[1]!.inputs.reportedOutcome,'permission_denied');
  assert.ok(captures[1]!.sources.some(source=>source.source==='native-notice-receipt'&&source.quality==='reported'));
});

test('the published examples and every answer of the handler match the OpenAPI schemas', async () => {
  assert.ok(validateList(examples.list.value), JSON.stringify(validateList.errors));
  assert.ok(validateList(examples.otherDeviceOffered.value), JSON.stringify(validateList.errors));
  assert.ok(validateReceipt(examples.devicePermissionDenied.value), JSON.stringify(validateReceipt.errors));
  assert.ok(validateBody(examples.receipt.value), JSON.stringify(validateBody.errors));
  assert.ok(validateReceipt(examples.receiptResult.value), JSON.stringify(validateReceipt.errors));
  const { request } = http({ records: [{ owner: A, notice: notice(1) }, { owner: A, notice: notice(2, 'policy_lifecycle_changed') }] });
  const list = await request('/api/v1/notices');
  assert.ok(validateList(await list.json()), JSON.stringify(validateList.errors));
  const receipt = await request(`/api/v1/notices/${event(1)}/receipt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outcome: 'presented' }) });
  assert.ok(validateReceipt(await receipt.json()), JSON.stringify(validateReceipt.errors));
  for (const response of [await request('/api/v1/notices', { method: 'POST' }), await request(`/api/v1/notices/${event(9)}/receipt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"outcome":"presented"}' }),
    await request(`/api/v1/notices/${event(1)}/receipt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"outcome":"permission_denied"}' }),
    await request(`/api/v1/notices/${event(1)}/receipt`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })]) {
    assert.ok(validateError(await response.json()), JSON.stringify(validateError.errors));
  }
});

test('the expiry trigger asks for the policies ending within seven days, with its clock, and reports how many it announced', async () => {
  const asked: [Date, number][] = [];
  const notices = new ExpiryNotices({ announceExpiring: async (now, windowMs) => { asked.push([now, windowMs]); return 3; } }, { now: () => new Date('2026-11-18T12:00:00.000Z') });
  assert.equal(await notices.run(), 3);
  assert.deepEqual(asked, [[new Date('2026-11-18T12:00:00.000Z'), 7 * 24 * 3600 * 1000]]);
  assert.equal(EXPIRY_WINDOW_MS, 7 * 24 * 3600 * 1000);
});

test('an expiry notice follows the policy choice, and only a stored notice with the expiry identity becomes a view', async () => {
  const base = { eventId: event(5), createdAt: new Date('2026-11-18T11:00:00.000Z') };
  const payload = { category: 'policy_expiring', clientId: A, policyId, expiresAt: '2026-11-25T11:00:00.000Z' };
  const stored = noticeFrom({ ...base, eventType: 'policy.expiry.notice', payload });
  assert.deepEqual([stored?.kind, stored?.category], ['policy_expiring', 'policy']);
  assert.equal(noticeFrom({ ...base, eventType: 'policy.expiry.notice', payload: { ...payload, category: 'policy_lifecycle_changed' } }), null);
  const { store } = memoryStore([{ owner: A, notice: stored! }]);
  const service = new Notices(store, clock);
  assert.deepEqual(await service.list({ clientId: A }, { ...on, policy: false }, trace), []);
  assert.deepEqual((await new Notices(memoryStore([{ owner: A, notice: stored! }]).store, clock).list({ clientId: A }, on, trace)).map(item => item.kind), ['policy_expiring']);
});

test('a claim status notice answers to the claims choice, names only the policy and is told apart from the other categories', async () => {
  const claim = claimNoticeFrom({ eventId: event(8), policyId: policyId.toUpperCase(), createdAt: new Date('2026-11-18T11:00:00.000Z') });
  assert.deepEqual(claim, { eventId: event(8), kind: 'claim_status_changed', category: 'claims', policyId, occurredAt: '2026-11-18T11:00:00.000Z' });
  assert.equal(claimNoticeFrom({ eventId: 'nope', policyId, createdAt: new Date() }), null);
  assert.equal(claimNoticeFrom({ eventId: event(8), policyId: 'nope', createdAt: new Date() }), null);
  const owner = { clientId: A, subjectToken: '20000000-0000-4000-8000-00000000000a' };
  const withClaims = { ...on, claims: true };
  assert.deepEqual((await new Notices(memoryStore([{ owner: A, notice: claim! }]).store, clock).list(owner, withClaims, trace)).map(item => [item.kind, item.category, item.state]), [['claim_status_changed', 'claims', 'offered']]);
  const suppressed = memoryStore([{ owner: A, notice: claim! }]);
  assert.deepEqual(await new Notices(suppressed.store, clock).list(owner, { ...withClaims, claims: false }, trace), [], 'a claims choice that is off offers nothing');
  assert.deepEqual(suppressed.writes, [`${dispatchConsumer}:suppressed_preference`]);
});
