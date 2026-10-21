import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import worker from '../apps/web/worker/index';
import { verificationBase as base, verificationHttpSetup } from './support/identity-verification-http';
import { verificationIdentity } from './support/identity-verification-fakes';

const spec = parse(readFileSync('packages/contracts/openapi/v1/identity-verifications.yaml', 'utf8'));
const ajv = new Ajv({ strict: false });
addFormats(ajv);
const schemaId = 'https://solventa.test/identity-verifications.yaml';
ajv.addSchema({ ...spec, $id: schemaId });
const env = { APP_ENV: 'dev' } as IdentityEnv;

test('published synthetic examples conform to the same public response schemas', () => {
  const examples = JSON.parse(readFileSync('packages/contracts/examples/identity-verifications.json', 'utf8'));
  for (const value of Object.values(examples.cases)) {
    const validates = ajv.getSchema(`${schemaId}#/components/schemas/Current`)!;
    assert.equal(validates({ verification: value, traceId: crypto.randomUUID() }), true, JSON.stringify(validates.errors));
  }
  for (const value of Object.values(examples.terms)) {
    const validates = ajv.getSchema(`${schemaId}#/components/schemas/TermsEnvelope`)!;
    assert.equal(validates({ terms: value, traceId: crypto.randomUUID() }), true, JSON.stringify(validates.errors));
  }
  const validates = ajv.getSchema(`${schemaId}#/components/schemas/FixturesEnvelope`)!;
  assert.equal(validates({ fixtures: examples.fixtures, traceId: crypto.randomUUID() }), true, JSON.stringify(validates.errors));
});
async function call(r: ReturnType<typeof verificationHttpSetup>, path = '', method = 'GET', body?: object, options: { key?: string; token?: string | null; headers?: Record<string, string>; raw?: string } = {}) {
  const response = await r.app.request('https://dev.solventa.site' + base + path, {
    method,
    headers: { Accept: 'application/json', ...(options.token === null ? {} : { Authorization: 'Bearer ' + (options.token ?? 'synthetic.jwt.token') }),
      ...(body || options.raw !== undefined ? { 'Content-Type': 'application/json', 'Idempotency-Key': options.key ?? randomUUID() } : {}),
      ...options.headers },
    ...(body || options.raw !== undefined ? { body: options.raw ?? JSON.stringify(body) } : {}),
  }, env);
  const data = await response.json();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-trace-id'), data.traceId);
  const name = response.status >= 400 ? 'Error' : path.startsWith('/terms') ? 'TermsEnvelope' : path === '/fixtures' ? 'FixturesEnvelope'
    : path === '' && method === 'GET' ? 'Current' : 'Envelope';
  const validates = ajv.getSchema(`${schemaId}#/components/schemas/${name}`)!;
  assert.equal(validates(data), true, `${name}: ${JSON.stringify(validates.errors)}`);
  return { response, data };
}
async function ready(r: ReturnType<typeof verificationHttpSetup>, document = 'document-readable') {
  let result = await call(r, '', 'POST', { textVersion: 1, locale: 'es-CO' });
  assert.equal(result.response.status, 201);
  for (const [step, reference] of [['document', document], ['selfie', 'selfie-matched'], ['liveness', 'liveness-passed']]) {
    result = await call(r, `/${result.data.verification.id}/steps/${step}`, 'PUT', { ...r.fixture(reference), expectedVersion: result.data.verification.version });
    assert.equal(result.response.status, 200);
  }
  return result.data.verification;
}

test('terms and fixtures are native-authenticated and the empty current case matches OpenAPI', async () => {
  const r = verificationHttpSetup();
  assert.equal((await call(r)).data.verification, null);
  const terms = await call(r, '/terms?locale=en-US');
  assert.equal(terms.data.terms.validityHours, 24);
  assert.equal(terms.data.terms.locale, 'en-US');
  assert.match(terms.data.terms.wording, /simulated/);
  assert.equal((await call(r, '/fixtures')).data.fixtures.length, 9);
  assert.equal((await call(r, '/terms?locale=xx')).response.status, 400);
  assert.equal((await call(r, '/terms?locale=es-CO&locale=en-US')).response.status, 400);
  assert.equal((await call(r, '/fixtures?verdict=approved')).response.status, 400);
});

test('positive onboarding uses the real handlers and simulated provider with contract-shaped responses', async () => {
  const r = verificationHttpSetup();
  const view = await ready(r);
  const evaluated = await call(r, `/${view.id}/evaluate`, 'POST', { expectedVersion: view.version });
  assert.equal(evaluated.response.status, 200);
  assert.equal(evaluated.data.verification.status, 'approved');
  assert.equal(evaluated.data.verification.result.simulated, true);
  const revoked = await call(r, `/${view.id}/revoke`, 'POST', {});
  assert.equal(revoked.data.verification.status, 'revoked');
  assert.deepEqual(revoked.data.verification.steps, []);
  assert.equal(r.store.users.get(verificationIdentity.providerSubject)?.session, verificationIdentity.sessionReference);
});

test('failure, assistance and step-specific retry retain valid progress through the HTTP contract', async () => {
  const r = verificationHttpSetup();
  let view = await ready(r, 'document-unreadable');
  view = (await call(r, `/${view.id}/evaluate`, 'POST', { expectedVersion: view.version })).data.verification;
  assert.equal(view.status, 'not_verified');
  assert.deepEqual(view.steps.map((step: { step: string }) => step.step), ['selfie', 'liveness']);
  view = (await call(r, `/${view.id}/assistance`, 'POST', { expectedVersion: view.version })).data.verification;
  const reference = view.assistance.reference;
  assert.equal(view.assistance.status, 'pending');
  assert.equal((await call(r)).data.verification.assistance.reference, reference);
  view = (await call(r, `/${view.id}/steps/document`, 'PUT', { ...r.fixture('document-readable'), expectedVersion: view.version })).data.verification;
  const retried = await call(r, `/${view.id}/evaluate`, 'POST', { expectedVersion: view.version });
  assert.equal(retried.data.verification.status, 'approved');
  assert.equal(retried.data.verification.assistance.reference, reference);
});

test('technical failure returns 503 with saved unavailable progress instead of an identity rejection', async () => {
  const r = verificationHttpSetup();
  const view = await ready(r, 'document-technical');
  const result = await call(r, `/${view.id}/evaluate`, 'POST', { expectedVersion: view.version });
  assert.equal(result.response.status, 503);
  assert.equal(result.data.error, 'verification_unavailable');
  assert.equal(result.data.verification.status, 'unavailable');
  assert.equal(result.data.verification.steps.length, 3);
  assert.equal((await call(r)).data.verification.status, 'unavailable');
});

test('a public request cannot choose the owner, verdict, expiry, attempt limit or arbitrary file', async () => {
  const r = verificationHttpSetup();
  for (const extra of [{ clientId: randomUUID() }, { approved: true }, { expiresAt: '2099-01-01T00:00:00Z' }, { maxAttempts: 100 }]) {
    assert.equal((await call(r, '', 'POST', { textVersion: 1, locale: 'es-CO', ...extra })).response.status, 400);
  }
  const { data } = await call(r, '', 'POST', { textVersion: 1, locale: 'es-CO' });
  assert.equal((await call(r, `/${data.verification.id}/steps/document`, 'PUT', { reference: 'personal-image', sha256: '0'.repeat(64), corpusVersion: 'synthetic-identity.v1', expectedVersion: 1 })).response.status, 400);
  assert.equal((await call(r, `/${data.verification.id}/steps/document`, 'PUT', { ...r.fixture('document-readable'), expectedVersion: 1, verdict: 'approved' })).response.status, 400);
  assert.equal(r.calls, 0);
});

test('missing or invalid native tokens and cookies are rejected with safe durable denials', async () => {
  const r = verificationHttpSetup();
  for (const options of [{ token: null }, { token: 'partner.jwt.token' }]) {
    const result = await call(r, '', 'GET', undefined, options);
    assert.equal(result.response.status, 401);
    assert.match(result.response.headers.get('www-authenticate')!, /Bearer/);
  }
  assert.equal((await call(r, '', 'GET', undefined, { headers: { Cookie: 'web-session' } })).response.status, 400);
  assert.equal(r.denials.length, 2);
  assert.ok(r.denials.every(value => value.decision.operation === 'identity-verifications:read'));
  assert.ok(!JSON.stringify(r.denials).includes('partner.jwt.token'));
  assert.equal(r.store.rows.size, 0);
  r.flags.deniedPersistence = true;
  assert.equal((await call(r, '', 'GET', undefined, { token: null })).response.status, 503);
});

test('onboarding operations are granted to an active native user but never web or partner policy', async () => {
  const r = verificationHttpSetup();
  for (const operation of ['identity-verifications:read', 'identity-verifications:write']) {
    assert.equal((await r.access.mobileUser(verificationIdentity, operation)).allowed, true);
    assert.equal((await r.access.webUser(verificationIdentity, operation)).allowed, false);
    assert.equal((await r.access.partner({ issuer: 'test', organizationId: 'test', applicationId: 'test', scopes: [operation] }, operation)).allowed, false);
  }
  r.store.denied = true;
  assert.equal((await call(r)).response.status, 401);
});

test('foreign and missing cases are indistinguishable and failed denial persistence changes both to 503', async () => {
  const r = verificationHttpSetup();
  const view = await ready(r);
  for (const id of [view.id, randomUUID()]) {
    const result = await call(r, `/${id}/revoke`, 'POST', {}, { token: 'synthetic.other.token' });
    assert.equal(result.response.status, 404);
    assert.equal(result.data.error, 'not_found');
  }
  r.flags.deniedPersistence = true;
  assert.equal((await call(r, `/${view.id}/revoke`, 'POST', {}, { token: 'synthetic.other.token' })).response.status, 503);
});

test('revoked consent blocks evaluation and records the safe resource denial', async () => {
  const r = verificationHttpSetup();
  const view = await ready(r);
  await call(r, `/${view.id}/revoke`, 'POST', {});
  const result = await call(r, `/${view.id}/evaluate`, 'POST', { expectedVersion: view.version });
  assert.equal(result.response.status, 409);
  assert.equal(result.data.error, 'consent_inactive');
  assert.equal(r.calls, 0);
  assert.equal(r.denials.length, 1);
});

test('JSON size, malformed data, idempotency conflicts, methods and provider outages keep normalized contracts', async () => {
  const r = verificationHttpSetup();
  const key = randomUUID();
  assert.equal((await call(r, '', 'POST', undefined, { raw: 'not-json' })).response.status, 400);
  assert.equal((await call(r, '', 'POST', undefined, { raw: ' '.repeat(4097) })).response.status, 400);
  assert.equal((await call(r, '', 'POST', { textVersion: 1, locale: 'es-CO' }, { headers: { 'Idempotency-Key': '' } })).response.status, 400);
  assert.equal((await call(r, '', 'POST', { textVersion: 2, locale: 'es-CO' })).response.status, 409);
  assert.equal((await call(r, '', 'POST', { textVersion: 1, locale: 'es-CO' }, { key })).response.status, 201);
  assert.equal((await call(r, '', 'POST', { textVersion: 1, locale: 'en-US' }, { key })).response.status, 409);
  const method = await call(r, '', 'DELETE');
  assert.equal(method.response.status, 405);
  assert.equal(method.response.headers.get('allow'), 'GET, POST');
  r.flags.providerUnavailable = true;
  const unavailable = await call(r);
  assert.equal(unavailable.response.status, 503);
  assert.equal(JSON.stringify(unavailable.data).includes('sensitive_provider_exception'), false);
});

test('the gateway retains security headers and active-version behavior without invented retirement notices', async () => {
  const r = verificationHttpSetup();
  let forwarded = 0;
  const gatewayEnv = { APP_ENV: 'dev', IDENTITY: { fetch: (request: Request) => { forwarded++; return r.app.fetch(request, env); } } } as unknown as WebEnv;
  for (const authenticated of [true, false]) {
    const response = await worker.fetch(new Request('https://dev.solventa.site' + base, {
      headers: authenticated ? { Authorization: 'Bearer synthetic.jwt.token' } : {},
    }), gatewayEnv);
    assert.equal(response.status, authenticated ? 200 : 401);
    assert.equal(response.headers.get('deprecation'), null);
    assert.equal(response.headers.get('sunset'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.headers.get('x-trace-id'));
  }
  assert.equal(forwarded, 2);
  const unknown = await worker.fetch(new Request('https://dev.solventa.site/api/v99/mobile/identity-verifications'), gatewayEnv);
  assert.equal(unknown.status, 404);
  assert.equal(forwarded, 2);
});
