import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Hono } from 'hono';
import { parse } from 'yaml';
import { assistanceOperation, assistanceSearchPath, parseAssistanceResults, parseAssistanceSearch } from '@solventa/contracts';
import { ApiAccess } from '../backend/identity-consent-ecosystem/src/application/api-access';
import { mountAssistance } from '../backend/policy-claims-payments/src/adapters/inbound/assistance-http';
import { searchSyntheticAssistance } from '../backend/policy-claims-payments/src/adapters/outbound/synthetic-assistance-directory';
import { fetchService } from '../apps/web/worker/service-fetch';

const principal = { clientId: '10000000-0000-4000-8000-000000000001', subjectToken: '20000000-0000-4000-8000-000000000002' };
const identity = { emailVerified: true, providerSubject: 'synthetic', sessionReference: 'session' };
const spec = parse(readFileSync('packages/contracts/openapi/v1/assistance-providers.yaml', 'utf8'));
const ajv = new Ajv({ strict: false });
addFormats(ajv);
const validate = ajv.compile({ ...spec.components.schemas.SearchResult, components: spec.components });
const samples = JSON.parse(readFileSync('packages/contracts/examples/assistance-providers.json', 'utf8'));
const url = 'https://staging.solventa.site' + assistanceSearchPath;

function setup(search = searchSyntheticAssistance) {
  const app = new Hono<{ Bindings: PolicyEnv }>();
  const access = new ApiAccess({ find: async () => null }, {
    open: async () => principal, find: async candidate => candidate.sessionReference === identity.sessionReference ? principal : null,
    revoke: async () => {},
  });
  let authorizationCount = 0;
  mountAssistance(app, {
    async authorize(input) {
      authorizationCount += 1;
      if (input.kind === 'mobile' && input.token === 'synthetic.jwt.token') return access.mobileUser(identity, input.operation);
      if (input.kind === 'web' && input.cookie === 'synthetic-web' && input.origin === input.requestOrigin) {
        return access.webUser(identity, input.operation);
      }
      return { allowed: false, error: 'unauthorized', status: 401 };
    },
    search,
  }, async request => {
    try { return await request.json(); } catch { return null; }
  });
  return { request: (body: unknown, headers: Record<string, string>) => fetchService(new Request(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  }), { fetch: request => app.fetch(request, { APP_ENV: 'staging' } as PolicyEnv) }),
  count: () => authorizationCount, access };
}

test('web and native use one authenticated search endpoint and its documented response', async () => {
  const api = setup();
  const web = await api.request(samples.manual, { cookie: '__Host-solventa-session=synthetic-web', origin: new URL(url).origin });
  const mobile = await api.request(samples.nearby, { authorization: 'Bearer synthetic.jwt.token' });
  for (const response of [web, mobile]) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body: unknown = await response.json();
    assert.equal(validate(body), true, JSON.stringify(validate.errors));
    assert.equal(parseAssistanceResults(body)?.length, 2);
    assert.doesNotMatch(JSON.stringify(body), /latitude|longitude|locationAuthorized/);
  }
  assert.equal(api.count(), 2);
});

test('authorization and explicit location permission fail before searching', async () => {
  let searches = 0;
  const api = setup(input => { searches += 1; return searchSyntheticAssistance(input); });
  assert.equal((await api.request(samples.manual, {})).status, 401);
  assert.equal((await api.request(samples.manual, { authorization: 'Bearer synthetic.jwt.token', origin: new URL(url).origin })).status, 400);
  assert.equal((await api.request({ ...samples.nearby, locationAuthorized: false }, { authorization: 'Bearer synthetic.jwt.token' })).status, 400);
  assert.equal((await api.request({ ...samples.nearby, coordinates: { latitude: 91, longitude: 0 } }, { authorization: 'Bearer synthetic.jwt.token' })).status, 400);
  assert.equal((await api.request({ kind: 'manual', query: 'a'.repeat(4000) }, { authorization: 'Bearer synthetic.jwt.token' })).status, 400);
  assert.equal(searches, 0);
  assert.equal(parseAssistanceSearch({ kind: 'manual', query: ' Bogotá ', ownerId: principal.clientId }), null);
  assert.equal((await api.access.partner({ issuer: 'synthetic', applicationId: 'app', organizationId: 'org', scopes: [assistanceOperation] }, assistanceOperation)).allowed, false);
});

test('a directory failure is distinct from an authorized empty result', async () => {
  const credential = { authorization: 'Bearer synthetic.jwt.token' };
  const failed = await setup(() => ({ status: 'unavailable' })).request(samples.manual, credential);
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).error, samples.unavailable.error);
  const empty = await setup().request({ kind: 'manual', query: 'Unsupported city' }, credential);
  assert.equal(empty.status, 200);
  assert.deepEqual(parseAssistanceResults(await empty.json()), samples.empty.providers);
});
