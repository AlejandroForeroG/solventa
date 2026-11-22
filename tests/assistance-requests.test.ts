import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Hono } from 'hono';
import { parse } from 'yaml';
import { assistanceRequestsPath, parseAssistanceRequestBody, parseAssistanceRequestList, parseAssistanceRequestResponse } from '@solventa/contracts';
import { ApiAccess } from '../backend/identity-consent-ecosystem/src/application/api-access';
import { mountAssistanceRequests } from '../backend/policy-claims-payments/src/adapters/inbound/assistance-requests-http';
import { findSyntheticProvider } from '../backend/policy-claims-payments/src/adapters/outbound/synthetic-assistance-directory';
import { digest, directory, fakeAssistanceStore, sequentialReference } from './support/assistance-request-fakes';
import { AssistanceRequests } from '../backend/policy-claims-payments/src/application/assistance-requests';
import type { AssistanceOwner, AssistanceRequestStore } from '../backend/policy-claims-payments/src/application/ports/assistance-request';
import { newAssistanceReference } from '../backend/policy-claims-payments/src/adapters/outbound/random-assistance-reference';
import { canonicalAssistanceRequest, type AssistanceRequestRecord } from '../backend/policy-claims-payments/src/domain/assistance-request';

const ownerA: AssistanceOwner = { clientId: '10000000-0000-4000-8000-00000000000a', subjectToken: '20000000-0000-4000-8000-00000000000a' };
const ownerB: AssistanceOwner = { clientId: '10000000-0000-4000-8000-00000000000b', subjectToken: '20000000-0000-4000-8000-00000000000b' };
const identity = { emailVerified: true, providerSubject: 'synthetic', sessionReference: 'session' };
const trace = '30000000-0000-4000-8000-000000000001';
const samples = JSON.parse(readFileSync('packages/contracts/examples/assistance-providers.json', 'utf8'));
const spec = parse(readFileSync('packages/contracts/openapi/v1/assistance-providers.yaml', 'utf8'));
const ajv = new Ajv({ strict: false });
addFormats(ajv);
const validateResult = ajv.compile({ ...spec.components.schemas.AssistanceRequestResult, components: spec.components });
const validateList = ajv.compile({ ...spec.components.schemas.AssistanceRequestList, components: spec.components });
const validateError = ajv.compile({ ...spec.components.schemas.Error, components: spec.components });
const validateBody = ajv.compile({ ...spec.components.schemas.AssistanceRequestBody, components: spec.components });
// What a customer sends, and what the use case receives once the edge validated it.
const address = { providerId: 'demo-bog-workshop', place: { kind: 'address', address: '  Calle de prueba 10, Bogotá ' } };
const device = { providerId: 'demo-bog-workshop', place: { kind: 'device', authorized: true, coordinates: { latitude: 4.6480004, longitude: -74.098 } } };
const validated = (body: unknown) => {
  const parsed = parseAssistanceRequestBody(body);
  assert.ok(parsed, JSON.stringify(body));
  return { providerId: parsed.providerId, place: parsed.place.kind === 'device' ? { kind: 'device' as const, ...parsed.place.coordinates } : { kind: 'address' as const, address: parsed.place.address } };
};
const addressInput = validated(address);
const deviceInput = validated(device);

test('a customer asks for assistance from a provider of the directory, and the request keeps the provider, the place, the date and its state', async () => {
  const { store } = fakeAssistanceStore();
  const requests = new AssistanceRequests(store, directory, digest, sequentialReference());
  const byAddress = await requests.create(ownerA, addressInput, 'retry-key-0001', trace);
  assert.equal(byAddress.status, 'created');
  const first = (byAddress as { request: AssistanceRequestRecord }).request;
  assert.deepEqual([first.status, first.provider.id, first.provider.name, first.place], ['requested', 'demo-bog-workshop', 'Taller de prueba Bogotá', { kind: 'address', address: 'Calle de prueba 10, Bogotá' }]);
  assert.match(first.reference, /^ASI-[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.equal(Object.hasOwn(first.provider, 'coordinates'), false, 'the stored provider is the public one');
  const byDevice = await requests.create(ownerA, deviceInput, 'retry-key-0002', trace);
  assert.deepEqual((byDevice as { request: AssistanceRequestRecord }).request.place, { kind: 'device', latitude: 4.648, longitude: -74.098 }, 'a position keeps six decimals');
  assert.notEqual((byDevice as { request: AssistanceRequestRecord }).request.reference, first.reference);
});

test('repeating a request creates no second one, and the same key for another request is a conflict', async () => {
  const { store, rows } = fakeAssistanceStore();
  const requests = new AssistanceRequests(store, directory, digest, sequentialReference());
  const created = await requests.create(ownerA, addressInput, 'retry-key-0001', trace);
  const replayed = await requests.create(ownerA, validated({ ...address, place: { kind: 'address', address: 'Calle de prueba 10, Bogotá' } }), 'retry-key-0001', trace);
  assert.equal(replayed.status, 'replayed');
  assert.deepEqual((replayed as { request: unknown }).request, (created as { request: unknown }).request);
  assert.equal((await requests.create(ownerA, deviceInput, 'retry-key-0001', trace)).status, 'idempotency_conflict');
  assert.equal((await requests.create(ownerA, { ...addressInput, providerId: 'demo-bog-expert' }, 'retry-key-0001', trace)).status, 'idempotency_conflict');
  assert.equal(rows.length, 1);
  assert.equal((await requests.create(ownerB, addressInput, 'retry-key-0001', trace)).status, 'created', 'the key belongs to its owner');
  assert.notEqual(await digest.sha256Hex(canonicalAssistanceRequest('demo-bog-workshop', { kind: 'address', address: 'a' })), await digest.sha256Hex(canonicalAssistanceRequest('demo-bog-workshop', { kind: 'device', latitude: 1, longitude: 2 })));
});

test('a request that is not valid is refused by the contract, and an unknown provider or an unavailable directory store nothing', async () => {
  const { store, rows } = fakeAssistanceStore();
  const requests = new AssistanceRequests(store, directory, digest, sequentialReference());
  for (const body of [null, [], {}, { providerId: 'demo-bog-workshop' }, { ...address, extra: 1 }, { ...address, providerId: 'Taller' }, { ...address, place: { kind: 'address', address: 'a' } },
    { ...address, place: { kind: 'address', address: 'x'.repeat(161) } }, { ...address, place: { kind: 'address', address: 'Calle\u0000 10' } },
    { ...device, place: { kind: 'device', coordinates: { latitude: 4.6, longitude: -74 } } }, { ...device, place: { ...device.place, authorized: false } },
    { ...device, place: { ...device.place, authorized: 'true' } }, { ...device, place: { ...device.place, coordinates: { latitude: 91, longitude: -74 } } },
    { ...device, place: { ...device.place, coordinates: { latitude: 4, longitude: -74, accuracy: 3 } } }]) {
    assert.equal(parseAssistanceRequestBody(body), null, JSON.stringify(body));
  }
  assert.deepEqual(parseAssistanceRequestBody(address)?.place, { kind: 'address', address: 'Calle de prueba 10, Bogotá' }, 'an address is trimmed');
  assert.equal((await requests.create(ownerA, { ...addressInput, providerId: 'demo-unknown' }, 'retry-key-0001', trace)).status, 'provider_not_found');
  const broken = new AssistanceRequests(store, { find: () => 'unavailable' }, digest, sequentialReference());
  assert.equal((await broken.create(ownerA, addressInput, 'retry-key-0001', trace)).status, 'directory_unavailable');
  assert.equal(rows.length, 0);
  assert.equal(findSyntheticProvider('demo-bog-workshop', { formatVersion: 'other', simulated: true, providers: [] }), 'unavailable');
  assert.equal(findSyntheticProvider('demo-nowhere'), null);
  for (const generated of Array.from({ length: 50 }, newAssistanceReference)) assert.match(generated, /^ASI-[0-9A-HJKMNP-TV-Z]{8}$/);
});

function setup(options: { failStore?: boolean } = {}) {
  const { store, rows } = fakeAssistanceStore();
  const app = new Hono<{ Bindings: PolicyEnv }>();
  const identities = new Map([['tokenA', ownerA], ['tokenB', ownerB]]);
  const accessFor = (owner: AssistanceOwner) => new ApiAccess({ find: async () => null }, { open: async () => owner, find: async () => owner, revoke: async () => {} });
  const failing: AssistanceRequestStore = { create: async () => { throw new Error('store down'); }, get: async () => { throw new Error('store down'); }, listOwn: async () => { throw new Error('store down'); } };
  mountAssistanceRequests(app, {
    async authorize(input) {
      const owner = input.kind === 'mobile' ? identities.get(input.token) : input.cookie === 'webA' ? ownerA : undefined;
      if (!owner) return { allowed: false, error: 'unauthorized', status: 401 };
      if (input.kind === 'web' && input.method !== 'GET' && input.origin !== input.requestOrigin) return { allowed: false, error: 'forbidden', status: 403 };
      return input.kind === 'mobile' ? accessFor(owner).mobileUser(identity, input.operation) : accessFor(owner).webUser(identity, input.operation);
    },
    requests: new AssistanceRequests(options.failStore ? failing : store, directory, digest, sequentialReference()),
  });
  const url = 'https://staging.solventa.site' + assistanceRequestsPath;
  const call = (path: string, init: RequestInit & { headers?: Record<string, string> }) => app.fetch(new Request(url + path, init), { APP_ENV: 'staging' } as PolicyEnv);
  const post = (body: unknown, headers: Record<string, string>, key = 'retry-key-0001') => call('', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key, ...headers }, body: JSON.stringify(body) });
  return { call, post, rows, origin: new URL(url).origin };
}
const mobileA = { authorization: 'Bearer tokenA' };
const mobileB = { authorization: 'Bearer tokenB' };

test('web and native create and follow their own requests through one documented contract', async () => {
  const api = setup();
  assert.equal(validateBody(samples.request.device), true); assert.equal(validateBody(samples.request.address), true);
  assert.deepEqual(parseAssistanceRequestBody(samples.request.device)?.place.kind, 'device');
  const mobile = await api.post(device, mobileA, 'mobile-key-0001');
  const web = await api.post(address, { cookie: '__Host-solventa-session=webA', origin: api.origin }, 'web-key-00001');
  for (const [response, kind] of [[mobile, 'device'], [web, 'address']] as const) {
    assert.equal(response.status, 201, kind);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body: unknown = await response.json();
    assert.equal(validateResult(body), true, JSON.stringify(validateResult.errors));
    assert.equal(parseAssistanceRequestResponse(body)?.place.kind, kind);
  }
  const id = ((await (await api.post(device, mobileA, 'mobile-key-0001')).json()) as { request: { id: string } }).request.id;
  const followed = await api.call('/' + id, { method: 'GET', headers: mobileA });
  assert.equal(followed.status, 200);
  const followedBody: unknown = await followed.json();
  assert.equal(validateResult(followedBody), true, JSON.stringify(validateResult.errors));
  assert.equal(parseAssistanceRequestResponse(followedBody)?.status, 'requested');
  const listed = await api.call('', { method: 'GET', headers: mobileA });
  const listBody: unknown = await listed.json();
  assert.equal(validateList(listBody), true, JSON.stringify(validateList.errors));
  assert.equal(parseAssistanceRequestList(listBody)?.length, 2, 'the web request of the same customer shows with the native one');
  assert.equal(validateResult(samples.request.created), true, JSON.stringify(validateResult.errors));
  assert.equal(validateError(samples.request.conflict), true);
});

test('repeating a request answers with the stored one, another request under the same key is refused, and nothing is stored twice', async () => {
  const api = setup();
  const created = await api.post(address, mobileA);
  assert.equal(created.status, 201);
  const replay = await api.post({ ...address, place: { kind: 'address', address: 'Calle de prueba 10, Bogotá' } }, mobileA);
  assert.equal(replay.status, 200);
  assert.deepEqual(((await replay.json()) as { request: unknown }).request, ((await created.json()) as { request: unknown }).request);
  const conflict = await api.post(device, mobileA);
  assert.equal(conflict.status, 409);
  assert.equal(validateError(await conflict.json()), true);
  assert.equal(api.rows.length, 1);
});

test('a customer never reads, lists or follows the request of another, and a missing session is refused', async () => {
  const api = setup();
  const id = ((await (await api.post(address, mobileA)).json()) as { request: { id: string } }).request.id;
  assert.equal((await api.call('/' + id, { method: 'GET', headers: mobileB })).status, 404, 'another customer looks at a request that does not exist');
  assert.deepEqual(((await (await api.call('', { method: 'GET', headers: mobileB })).json()) as { requests: unknown[] }).requests, []);
  assert.equal((await api.call('/' + id, { method: 'GET', headers: {} })).status, 401);
  assert.equal((await api.call('/' + id, { method: 'GET', headers: { authorization: 'Bearer nobody' } })).status, 401);
  assert.equal((await api.post(address, {})).status, 401);
  assert.equal((await api.call('', { method: 'GET', headers: { cookie: '__Host-solventa-session=webA', origin: 'https://evil.example' } })).status, 200, 'a read needs no Origin match, only the session');
  assert.equal((await api.post(address, { cookie: '__Host-solventa-session=webA', origin: 'https://evil.example' }, 'web-key-00002')).status, 403, 'a write from another origin is refused');
  assert.equal((await api.post(address, { ...mobileA, cookie: '__Host-solventa-session=webA' }, 'mix-key-00001')).status, 400, 'a token together with a cookie is refused');
  assert.equal((await api.call('/not-a-uuid', { method: 'GET', headers: mobileA })).status, 404);
  assert.equal(api.rows.length, 1);
});

test('the request is refused without a valid key, media type, size or fields, and other methods are not routes', async () => {
  const api = setup();
  for (const key of ['', 'short', 'has spaces in it', 'x'.repeat(129)]) {
    const response = await api.post(address, mobileA, key);
    assert.equal(response.status, 400, key);
    assert.deepEqual(((await response.json()) as { fields: string[] }).fields, ['idempotencyKey']);
  }
  assert.equal((await api.call('', { method: 'POST', headers: { ...mobileA, 'idempotency-key': 'retry-key-0001', 'content-type': 'text/plain' }, body: 'x' })).status, 415);
  const big = await api.post({ ...address, place: { kind: 'address', address: 'x'.repeat(5000) } }, mobileA);
  assert.equal(big.status, 400); assert.deepEqual(((await big.json()) as { fields: string[] }).fields, ['body']);
  assert.equal((await api.call('', { method: 'POST', headers: { ...mobileA, 'idempotency-key': 'retry-key-0001', 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await api.post({ ...address, providerId: 'demo-unknown' }, mobileA)).status, 404);
  for (const [method, path] of [['PUT', ''], ['DELETE', ''], ['POST', '/' + ownerA.clientId], ['PATCH', '/' + ownerA.clientId]] as const) {
    const response = await api.call(path, { method, headers: mobileA });
    assert.equal(response.status, 405, method + path);
    assert.match(response.headers.get('allow') ?? '', /GET/);
  }
  assert.equal(api.rows.length, 0);
});

test('when the store fails nothing is acknowledged', async () => {
  const api = setup({ failStore: true });
  const created = await api.post(address, mobileA);
  assert.equal(created.status, 503);
  assert.equal(((await created.json()) as { error: string }).error, 'service_unavailable');
  assert.equal((await api.call('', { method: 'GET', headers: mobileA })).status, 503);
});
