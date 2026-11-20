import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssistanceProviderMatch, AssistanceRequestBody, AssistanceRequestView } from '@solventa/contracts';
import { createAssistanceApi } from '../apps/mobile/src/features/assistance/adapters/assistance-api';
import { AssistanceRequestFailure, AssistanceRequestFlow, type AssistanceRequestApi, type RequestPlace } from '../apps/mobile/src/features/assistance/application/assistance-request-flow';
import { AuthFailure } from '../apps/mobile/src/features/authentication/domain/session';

const baseUrl = 'https://dev.solventa.site';
const traceId = '50000000-0000-4000-8000-0000000000f0';
const provider: AssistanceProviderMatch = { id: 'demo-bog-workshop', kind: 'workshop', name: 'Taller de prueba Bogotá', city: 'Bogotá', address: 'Calle de prueba 10', phone: '+570000000001', hours: 'Lun–vie 08:00–17:00' };
const address: RequestPlace = { kind: 'address', address: 'Calle de prueba 10, Bogotá' };
const device: RequestPlace = { kind: 'device', latitude: 4.648, longitude: -74.098 };
const stored = (id: string, place: AssistanceRequestView['place'] = address): AssistanceRequestView => ({ id, reference: 'ASI-7K2M9QXD', status: 'requested', provider, place, createdAt: '2026-11-12T22:30:00.000Z' });
const session = { execute: <T>(operation: (token: string) => Promise<T>) => operation('synthetic.jwt.token') };
const json = (body: unknown, status = 200, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });

// A server that remembers its requests by key, as the real one does: the same key and request returns the stored one.
function fakeServer() {
  const byKey = new Map<string, { body: string; request: AssistanceRequestView }>();
  const failNext: unknown[] = [];
  const keys: string[] = [];
  const api: AssistanceRequestApi = {
    async create(body: AssistanceRequestBody, key: string) {
      keys.push(key);
      const failure = failNext.shift();
      if (failure) throw failure;
      const known = byKey.get(key);
      if (known) { if (known.body !== JSON.stringify(body)) throw new AssistanceRequestFailure('conflict'); return known.request; }
      const request = stored(`40000000-0000-4000-8000-${String(byKey.size + 1).padStart(12, '0')}`, body.place.kind === 'device' ? { kind: 'device', ...body.place.coordinates } : body.place);
      byKey.set(key, { body: JSON.stringify(body), request });
      return request;
    },
    async list() { return [...byKey.values()].map(entry => entry.request); },
  };
  return { api, byKey, failNext, keys };
}
const flowOf = (api: AssistanceRequestApi) => { let n = 0; return new AssistanceRequestFlow({ api, newKey: () => `key-${String(++n).padStart(8, '0')}` }); };

test('nothing leaves the phone until the customer confirms, and a confirmed request shows its stored reference and state', async () => {
  const { api, byKey } = fakeServer();
  const flow = flowOf(api);
  flow.review(provider, device);
  assert.deepEqual(flow.getSnapshot().request, { kind: 'review', provider, place: device });
  assert.equal(byKey.size, 0, 'reviewing sends nothing');
  await flow.confirm();
  const snapshot = flow.getSnapshot();
  assert.equal(snapshot.request.kind, 'done');
  assert.equal(snapshot.request.kind === 'done' && snapshot.request.request.status, 'requested');
  assert.deepEqual(snapshot.own, { status: 'ready', requests: [...byKey.values()].map(entry => entry.request) }, 'the stored request appears in the customer’s own list');
  assert.equal(byKey.size, 1);
  assert.equal(JSON.parse([...byKey.values()][0].body).place.authorized, true, 'a device position travels only with the explicit authorization of the confirmation');
  flow.cancel();
  assert.equal(flow.getSnapshot().request.kind, 'idle');
});

test('a failed or uncertain send is never shown as stored, and the retry returns the same request instead of making another', async () => {
  const { api, byKey, failNext, keys } = fakeServer();
  const flow = flowOf(api);
  flow.review(provider, address);
  failNext.push(new AssistanceRequestFailure('unavailable'));
  await flow.confirm();
  assert.deepEqual(flow.getSnapshot().request, { kind: 'failed', provider, place: address, failure: 'unavailable' });
  await flow.confirm();
  assert.equal(flow.getSnapshot().request.kind, 'done');
  assert.equal(new Set(keys).size, 1, 'the retry carries the key of the first attempt');
  assert.equal(byKey.size, 1);
  // An answer lost after the server stored the request: the retry finds it by the key.
  const lost = fakeServer();
  const flow2 = flowOf(lost.api);
  flow2.review(provider, address);
  const original = lost.api.create.bind(lost.api);
  let first = true;
  lost.api.create = async (body, key) => { const created = await original(body, key); if (first) { first = false; throw new Error('network'); } return created; };
  await flow2.confirm();
  assert.equal(flow2.getSnapshot().request.kind, 'failed');
  assert.equal(lost.byKey.size, 1, 'the server did store it');
  await flow2.confirm();
  assert.equal(flow2.getSnapshot().request.kind, 'done');
  assert.equal(lost.byKey.size, 1, 'and the retry created no second request');
});

test('each refusal is its own message, one the key would meet again is not retried with it, and reviewing anew starts a new key', async () => {
  const { api, failNext, keys } = fakeServer();
  const flow = flowOf(api);
  const failures: [unknown, string][] = [[new AuthFailure('unauthorized'), 'unauthorized'], [new AuthFailure('forbidden'), 'forbidden'], [new AssistanceRequestFailure('invalid'), 'invalid'],
    [new AssistanceRequestFailure('not_found'), 'not_found'], [new AssistanceRequestFailure('conflict'), 'conflict'], [new AssistanceRequestFailure('invalid_response'), 'unavailable'], [new Error('boom'), 'unavailable']];
  for (const [error, expected] of failures) {
    flow.review(provider, address);
    failNext.push(error);
    await flow.confirm();
    const state = flow.getSnapshot().request;
    assert.equal(state.kind === 'failed' && state.failure, expected);
  }
  assert.equal(new Set(keys).size, failures.length, 'every new review has its own key');
  flow.review(provider, address);
  failNext.push(new AssistanceRequestFailure('conflict'));
  await flow.confirm(); await flow.confirm();
  assert.notEqual(keys[keys.length - 1], keys[keys.length - 2], 'a key that met a conflict is not retried');
  flow.review(provider, device);
  assert.equal(flow.getSnapshot().request.kind, 'review');
  await flow.confirm(); await flow.confirm();
  assert.equal(flow.getSnapshot().request.kind, 'done');
});

test('a confirmation in progress cannot be repeated or abandoned, and the own list failing is not a failed request', async () => {
  const { api, byKey } = fakeServer();
  let release: () => void = () => {};
  const slow: AssistanceRequestApi = { create: async (body, key) => { await new Promise<void>(resolve => { release = resolve; }); return api.create(body, key); }, list: api.list };
  const flow = flowOf(slow);
  flow.review(provider, address);
  const pending = flow.confirm();
  assert.equal(flow.getSnapshot().request.kind, 'sending');
  await flow.confirm(); flow.cancel(); flow.review(provider, device);
  assert.equal(flow.getSnapshot().request.kind, 'sending', 'neither a second confirmation, nor leaving, nor another review disturbs a send');
  release();
  await pending;
  assert.equal(byKey.size, 1);
  const broken = flowOf({ create: api.create, list: async () => { throw new Error('offline'); } });
  broken.review(provider, address);
  await broken.confirm();
  assert.equal(broken.getSnapshot().request.kind, 'done', 'the request is stored even when the list cannot be read');
  assert.deepEqual(broken.getSnapshot().own, { status: 'failed' });
  await broken.refresh();
  assert.deepEqual(broken.getSnapshot().own, { status: 'failed' });
});

const http = (respond: (url: string, init: RequestInit) => Response | Promise<Response>) => createAssistanceApi(baseUrl, session, (async (url: string, init: RequestInit) => respond(url, init)) as typeof fetch);
const body: AssistanceRequestBody = { providerId: provider.id, place: { kind: 'address', address: 'Calle de prueba 10, Bogotá' } };
const result = { simulated: true, request: stored('40000000-0000-4000-8000-000000000001'), traceId };

test('the request is posted with the token, the key and no cookies, and only a valid answer is accepted', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const view = await http((url, init) => { seen = { url, init }; return json(result, 201); }).createRequest(body, 'retry-key-0001');
  assert.equal(seen?.url, `${baseUrl}/api/v1/assistance/requests`);
  assert.equal(seen?.init.method, 'POST'); assert.equal(seen?.init.credentials, 'omit');
  assert.deepEqual(seen?.init.headers, { Accept: 'application/json', Authorization: 'Bearer synthetic.jwt.token', 'Content-Type': 'application/json', 'Idempotency-Key': 'retry-key-0001' });
  assert.deepEqual(JSON.parse(String(seen?.init.body)), body);
  assert.deepEqual(view, result.request);
  assert.equal((await http(() => json(result, 200)).createRequest(body, 'retry-key-0001')).reference, 'ASI-7K2M9QXD', 'a replay answers 200');
  for (const answer of [{ ...result, simulated: false }, { ...result, request: { ...result.request, status: 'dispatched' } }, { ...result, request: { ...result.request, reference: 'ASI-lowercase' } },
    { ...result, request: { ...result.request, provider: { ...provider, distanceKm: 3 } } }, { ...result, request: { ...result.request, place: { kind: 'address' } } }, { ...result, extra: 1 }, '{', '[]']) {
    await assert.rejects(http(() => json(answer, 201)).createRequest(body, 'retry-key-0001'), (error: AssistanceRequestFailure) => error.code === 'invalid_response', JSON.stringify(answer).slice(0, 60));
  }
  await assert.rejects(http(() => json(result, 201, 'text/html')).createRequest(body, 'retry-key-0001'), (error: AssistanceRequestFailure) => error.code === 'invalid_response');
});

test('every status of the contract becomes a distinct failure and an outage is never read as one', async () => {
  const outcome = (status: number) => http(() => json({ error: 'x', traceId }, status)).createRequest(body, 'retry-key-0001')
    .then(() => 'ok', (error: AssistanceRequestFailure | AuthFailure) => error instanceof AuthFailure ? `auth:${error.kind}` : error.code);
  assert.equal(await outcome(401), 'auth:unauthorized'); assert.equal(await outcome(403), 'auth:forbidden');
  assert.equal(await outcome(400), 'invalid'); assert.equal(await outcome(404), 'not_found'); assert.equal(await outcome(409), 'conflict');
  for (const status of [415, 429, 500, 503]) assert.equal(await outcome(status), 'unavailable', String(status));
  await assert.rejects(http(() => { throw new Error('network'); }).createRequest(body, 'retry-key-0001'), (error: AssistanceRequestFailure) => error.code === 'unavailable');
});

test('the own list is read with the token and checked, and a request of the customer is never trusted beyond the contract', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const list = await http((url, init) => { seen = { url, init }; return json({ simulated: true, requests: [result.request], traceId }); }).listRequests();
  assert.equal(seen?.url, `${baseUrl}/api/v1/assistance/requests`);
  assert.equal(seen?.init.method, 'GET');
  assert.deepEqual(list, [result.request]);
  assert.deepEqual(await http(() => json({ simulated: true, requests: [], traceId })).listRequests(), []);
  for (const answer of [{ simulated: true, requests: [{ ...result.request, id: 'nope' }], traceId }, { simulated: true, requests: 'x', traceId }, { requests: [], traceId }]) {
    await assert.rejects(http(() => json(answer)).listRequests(), (error: AssistanceRequestFailure) => error.code === 'invalid_response');
  }
});
