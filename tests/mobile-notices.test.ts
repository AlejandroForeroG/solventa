import assert from 'node:assert/strict';
import { destinationUrl, parseDestination, tappedNoticeId } from '../apps/mobile/src/features/notices/domain/destination';
import { clearNoticeLogin, consumeNoticeLogin, rememberNoticeLogin } from '../apps/mobile/src/features/notices/application/login-destination';
import { test } from 'node:test';
import { AuthFailure } from '../apps/mobile/src/features/authentication/domain/session';
import { createNoticesApi } from '../apps/mobile/src/features/notices/adapters/notices-api';
import { waitUntilShown } from '../apps/mobile/src/features/notices/adapters/wait-until-shown';
import { NoticeCenter } from '../apps/mobile/src/features/notices/application/notice-center';
import type { NoticesApi } from '../apps/mobile/src/features/notices/application/ports';
import { NoticeFailure, parseNotices, type Notice, type ReceiptOutcome } from '../apps/mobile/src/features/notices/domain/notice';

const policyId = '60000000-0000-4000-8000-000000000001';
const trace = '30000000-0000-4000-8000-000000000001';
const event = (n: number) => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const notice = (n: number, state: Notice['state'] = 'offered', kind: Notice['kind'] = 'parametric_payment_confirmed'): Notice =>
  ({ eventId: event(n), kind, category: kind === 'parametric_payment_confirmed' ? 'payments' : kind === 'claim_status_changed' ? 'claims' : 'policy', policyId, occurredAt: '2026-11-18T11:00:00.000Z', state });
const wire = (items: Notice[]) => ({ simulated: true, notices: items, traceId: trace });

function world(options: { notices?: Notice[]; granted?: boolean } = {}) {
  const received: [string, ReceiptOutcome][] = [];
  const shown: string[] = [];
  let permission = options.granted ?? true;
  let list = async (): Promise<Notice[]> => options.notices ?? [notice(1)];
  let receipt = async (eventId: string, outcome: ReceiptOutcome) => { received.push([eventId, outcome]); };
  let present = async (item: Notice) => { shown.push(item.eventId); };
  const api: NoticesApi = { list: () => list(), receipt: (eventId, outcome) => receipt(eventId, outcome) };
  const center = new NoticeCenter({ api, presenter: { present: item => present(item) }, permission: { granted: async () => permission } });
  return { center, received, shown, deny: () => { permission = false; }, listing: (next: typeof list) => { list = next; }, receipts: (next: typeof receipt) => { receipt = next; }, presenting: (next: typeof present) => { present = next; } };
}

test('an offered notice is shown once and the server is told it was presented', async () => {
  const w = world();
  await w.center.refresh();
  assert.deepEqual(w.shown, [event(1)]);
  assert.deepEqual(w.received, [[event(1), 'presented']]);
  assert.deepEqual(w.center.getSnapshot().notices.map(item => item.state), ['presented']);
  assert.equal(w.center.getSnapshot().status, 'ready');
});

test('a notice already confirmed is listed but never shown again', async () => {
  const w = world({ notices: [notice(1, 'presented'), notice(2, 'permission_denied')] });
  await w.center.refresh();
  assert.deepEqual(w.shown, []);
  assert.deepEqual(w.received, []);
  assert.equal(w.center.getSnapshot().notices.length, 2);
});

test('without the operating system permission the notice is reported as not presentable and nothing is shown', async () => {
  const w = world({ granted: false });
  await w.center.refresh();
  assert.deepEqual(w.shown, []);
  assert.deepEqual(w.received, [[event(1), 'permission_denied']]);
  assert.equal(w.center.getSnapshot().notices[0]?.state, 'permission_denied');
});

test('a presentation that fails reports nothing, so the notice is tried again, and a lost receipt is sent again', async () => {
  const w = world();
  w.presenting(async () => { throw new Error('system refused'); });
  await w.center.refresh();
  assert.deepEqual(w.received, [], 'an uncertain presentation is never reported as presented');
  assert.equal(w.center.getSnapshot().notices[0]?.state, 'offered');
  w.presenting(async item => { w.shown.push(item.eventId); });
  w.receipts(async () => { throw new NoticeFailure('unavailable'); });
  await w.center.refresh();
  assert.deepEqual(w.shown, [event(1)]);
  assert.equal(w.center.getSnapshot().notices[0]?.state, 'offered', 'not confirmed until the server stored the receipt');
  w.receipts(async (eventId, outcome) => { w.received.push([eventId, outcome]); });
  await w.center.refresh();
  assert.deepEqual(w.received, [[event(1), 'presented']]);
});

test('a receipt that could not be sent is retried without presenting the notice a second time', async () => {
  const w = world();
  // The server lists the notice as presented once it stored the receipt.
  w.listing(async () => [notice(1, w.received.length ? 'presented' : 'offered')]);
  w.receipts(async () => { throw new NoticeFailure('unavailable'); });
  await w.center.refresh();
  await w.center.refresh();
  assert.deepEqual(w.shown, [event(1)], 'one event, one presentation, however many receipts fail');
  w.receipts(async (eventId, outcome) => { w.received.push([eventId, outcome]); });
  await w.center.refresh();
  assert.deepEqual(w.shown, [event(1)]);
  assert.deepEqual(w.received, [[event(1), 'presented']]);
  await w.center.refresh();
  assert.deepEqual(w.received, [[event(1), 'presented']], 'a delivered receipt is not sent again');
  w.center.clear();
  w.listing(async () => [notice(1)]);
  w.receipts(async () => { throw new NoticeFailure('unavailable'); });
  await w.center.refresh();
  assert.deepEqual(w.shown, [event(1), event(1)], 'what was pending for a previous session is forgotten');
});

test('a session that ends while the permission is being read shows and reports nothing', async () => {
  const w = world();
  let answer!: (granted: boolean) => void;
  const center = new NoticeCenter({ api: { list: async () => [notice(1)], receipt: async (eventId, outcome) => { w.received.push([eventId, outcome]); } },
    presenter: { present: async item => { w.shown.push(item.eventId); } }, permission: { granted: () => new Promise<boolean>(resolve => { answer = resolve; }) } });
  const refreshing = center.refresh();
  while (!answer) await new Promise(resolve => setTimeout(resolve, 0));
  center.clear();
  answer(true);
  await refreshing;
  assert.deepEqual(w.shown, [], 'nothing is presented after the session ended');
  assert.deepEqual(w.received, []);
  assert.deepEqual(center.getSnapshot(), { status: 'idle', notices: [] });
});

test('an unconfirmed notice is offered to the device again', async () => {
  const w = world({ notices: [notice(1, 'unconfirmed')] });
  await w.center.refresh();
  assert.deepEqual(w.received, [[event(1), 'presented']]);
});

test('a failed collection keeps what was shown and says it failed; a concurrent refresh runs once', async () => {
  const w = world();
  await w.center.refresh();
  w.listing(async () => { throw new NoticeFailure('unavailable'); });
  await w.center.refresh();
  assert.equal(w.center.getSnapshot().status, 'failed');
  assert.equal(w.center.getSnapshot().notices.length, 1);
  let calls = 0; let release!: () => void;
  w.listing(() => { calls++; return new Promise<Notice[]>(resolve => { release = () => resolve([]); }); });
  const first = w.center.refresh(); const second = w.center.refresh();
  release(); await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test('ending the session clears the notices and nothing started before it reaches the next customer', async () => {
  const w = world();
  let release!: (items: Notice[]) => void;
  w.listing(() => new Promise<Notice[]>(resolve => { release = resolve; }));
  const refreshing = w.center.refresh();
  w.center.clear();
  release([notice(1)]);
  await refreshing;
  assert.deepEqual(w.shown, []);
  assert.deepEqual(w.received, []);
  assert.deepEqual(w.center.getSnapshot(), { status: 'idle', notices: [] });
});

test('a claim status notice is accepted only with the claims category', () => {
  const claim = notice(9, 'offered', 'claim_status_changed');
  assert.equal(claim.category, 'claims');
  assert.deepEqual(parseNotices(wire([claim])).map(item => [item.kind, item.category]), [['claim_status_changed', 'claims']]);
  assert.throws(() => parseNotices(wire([{ ...claim, category: 'policy' }])), NoticeFailure);
});

test('the server list is accepted only with exactly the contract fields, kinds and states', () => {
  assert.deepEqual(parseNotices(wire([notice(1)])).map(item => item.eventId), [event(1)]);
  assert.equal(parseNotices(wire([notice(2, 'offered', 'policy_expiring')]))[0]?.category, 'policy');
  const bad = (change: (item: Record<string, unknown>) => void) => {
    const item: Record<string, unknown> = { ...notice(1) }; change(item);
    assert.throws(() => parseNotices({ simulated: true, notices: [item], traceId: trace }), NoticeFailure);
  };
  bad(item => { item.extra = 1; });
  bad(item => { delete item.state; });
  bad(item => { item.state = 'delivered'; });
  bad(item => { item.kind = 'claim_status_changed'; });
  bad(item => { item.category = 'policy'; });
  bad(item => { item.eventId = 'x'; });
  bad(item => { item.occurredAt = 'yesterday'; });
  assert.throws(() => parseNotices({ simulated: false, notices: [], traceId: trace }), NoticeFailure);
  assert.throws(() => parseNotices({ simulated: true, notices: Array.from({ length: 21 }, (_, n) => notice(n + 1)), traceId: trace }), NoticeFailure);
});

// ---- The API client: the bearer token, the strict reading of the answer and the failure kinds.
function client(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const session = { baseUrl: 'https://staging.solventa.site', execute: <T>(operation: (token: string) => Promise<T>) => operation('synthetic.jwt.token') };
  const api = createNoticesApi('https://staging.solventa.site', session as never, (async (url: string, init: RequestInit) => { calls.push({ url, init }); return answer(url, init); }) as never);
  return { api, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('destination requests revalidate the session and use only typed same-environment locators', async () => {
  const target = { kind: 'policy', policyId: event(2), section: 'history' } as const;
  const { api, calls } = client(() => json({ destination: target, traceId: trace }));
  assert.deepEqual(await api.destination(event(1)), target);
  assert.equal(calls[0]?.url, `https://staging.solventa.site/api/v2/notices/${event(1)}/destination`);
  assert.equal(calls[0]?.init.credentials, 'omit');
  assert.equal(destinationUrl('https://dev.solventa.site', target), `https://dev.solventa.site/polizas#policy=${event(2)}&section=history`);
  assert.equal(destinationUrl('https://dev.solventa.site', { kind: 'claim', claimId: event(3) }), `https://dev.solventa.site/mis-siniestros/${event(3)}`);
  for (const destination of [{ ...target, section: 'https://example.com' }, { ...target, url: 'https://example.com' }, { kind: 'claim', claimId: '../foreign' }, null]) {
    assert.throws(() => parseDestination({ destination }), NoticeFailure);
  }
  assert.equal(tappedNoticeId({ screen: 'notice', eventId: event(1) }), event(1));
  for (const data of [null, { screen: 'notice', eventId: '../foreign' }, { screen: 'alerts' }, { screen: 'https://example.com', eventId: event(1) }]) assert.equal(tappedNoticeId(data), null);
});

test('notice sign-in returns once to a bounded event locator and abandons expired or cancelled continuations', () => {
  rememberNoticeLogin(event(1), 1000);
  assert.equal(consumeNoticeLogin(1001), event(1));
  assert.equal(consumeNoticeLogin(1002), null);
  rememberNoticeLogin(event(1), 1000);
  assert.equal(consumeNoticeLogin(901000), null);
  rememberNoticeLogin(event(1), 1000);
  assert.equal(consumeNoticeLogin(999), null);
  rememberNoticeLogin(event(1), 1000);
  clearNoticeLogin();
  assert.equal(consumeNoticeLogin(1001), null);
  rememberNoticeLogin('../foreign', 1000);
  assert.equal(consumeNoticeLogin(1001), null);
});

test('the client reads the list and sends the receipt with the bearer token and no cookies', async () => {
  const { api, calls } = client(url => url.endsWith('/receipt') ? json({ eventId: event(1), state: 'presented', replayed: false, traceId: trace }) : json(wire([notice(1)])));
  assert.deepEqual((await api.list()).map(item => item.eventId), [event(1)]);
  await api.receipt(event(1), 'presented');
  assert.equal(calls[0]?.url, 'https://staging.solventa.site/api/v2/notices');
  assert.equal(calls[1]?.url, `https://staging.solventa.site/api/v2/notices/${event(1)}/receipt`);
  assert.equal(calls[1]?.init.method, 'POST');
  assert.equal(calls[1]?.init.body, JSON.stringify({ outcome: 'presented' }));
  for (const call of calls) {
    assert.equal(call.init.credentials, 'omit');
    assert.equal((call.init.headers as Record<string, string>).Authorization, 'Bearer synthetic.jwt.token');
  }
});

test('the client tells a refused session, an outage, a rejection and a malformed answer apart', async () => {
  const failure = async (answer: () => Response | Promise<Response>, run: (api: ReturnType<typeof client>['api']) => Promise<unknown> = api => api.list()) => {
    try { await run(client(answer).api); } catch (error) { return error; }
    return null;
  };
  assert.ok(await failure(() => json({ error: 'unauthorized', traceId: trace }, 401)) instanceof AuthFailure);
  assert.ok(await failure(() => json({ error: 'forbidden', traceId: trace }, 403)) instanceof AuthFailure);
  assert.equal(((await failure(() => json({ error: 'service_unavailable', traceId: trace }, 503))) as NoticeFailure).code, 'unavailable');
  assert.equal(((await failure(() => { throw new TypeError('network'); })) as NoticeFailure).code, 'unavailable');
  assert.equal(((await failure(() => json({ error: 'conflict', traceId: trace }, 409), api => api.receipt(event(1), 'presented'))) as NoticeFailure).code, 'rejected');
  assert.equal(((await failure(() => json({ error: 'surprise', traceId: trace }, 409), api => api.receipt(event(1), 'presented'))) as NoticeFailure).code, 'invalid_response');
  assert.equal(((await failure(() => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }))) as NoticeFailure).code, 'invalid_response');
  assert.equal(((await failure(() => json({ simulated: true, notices: 'x', traceId: trace }))) as NoticeFailure).code, 'invalid_response');
  assert.equal(((await failure(() => json(wire([])), api => api.receipt('not-a-uuid', 'presented'))) as NoticeFailure).code, 'rejected');
  assert.equal(((await failure(() => json({ eventId: event(2), state: 'presented', replayed: false, traceId: trace }), api => api.receipt(event(1), 'presented'))) as NoticeFailure).code, 'invalid_response');
});

// ---- A notice is presented only when the system shows it, not when it merely accepted to schedule it.
const listing = (...ids: string[]) => ids.map(id => ({ request: { identifier: id } }));
const noWait = { attempts: 4, delayMs: 0, sleep: async () => {} };

test('a notification the system lists as shown is confirmed, even if it appears after a first empty look', async () => {
  const reads: string[][] = [[], [], [event(1)]];
  await waitUntilShown(async () => listing(...(reads.shift() ?? [event(1)])), event(1), noWait);
  assert.equal(reads.length, 0);
});

test('a notification that was only scheduled, or suppressed, is never confirmed', async () => {
  let looks = 0;
  await assert.rejects(waitUntilShown(async () => { looks++; return listing(event(2)); }, event(1), noWait), /notice_not_shown/);
  assert.equal(looks, 4, 'it looked as many times as allowed and then gave up');
  await assert.rejects(waitUntilShown(async () => { throw new Error('system unavailable'); }, event(1), noWait), /system unavailable/);
});

test('the coordinator reports nothing for a notice the system did not show, and tries it again on the next collection', async () => {
  const w = world();
  w.presenting(async () => { throw new Error('notice_not_shown'); });
  await w.center.refresh();
  assert.deepEqual(w.received, []);
  assert.equal(w.center.getSnapshot().notices[0]?.state, 'offered');
  w.presenting(async item => { w.shown.push(item.eventId); });
  await w.center.refresh();
  assert.deepEqual(w.received, [[event(1), 'presented']]);
});
