import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { RegisteredDevices } from '../backend/identity-consent-ecosystem/src/application/registered-devices';
import { createHttp } from '../backend/identity-consent-ecosystem/src/adapters/inbound/http';
import { MobileSessions } from '../backend/identity-consent-ecosystem/src/application/mobile-sessions';
import { unexpectedAuthentication } from './support/authentication-fakes';
import { InMemoryDeviceStore } from './support/registered-device-store';

const config = { clientId: 'client_synthetic', redirectUri: 'solventa://auth/callback' };
const installationId = '00000000-0000-4000-8000-000000000003';
const principal = { clientId: '00000000-0000-4000-8000-000000000001', subjectToken: '00000000-0000-4000-8000-000000000002' };

test('device routes follow OpenAPI, reject cookies/invalid IDs and scope every call to server-verified identity', async () => {
  const spec = parse(readFileSync('packages/contracts/openapi/v1/mobile-authentication.yaml', 'utf8'));
  const ajv = new Ajv({ strict: false }); addFormats(ajv);
  ajv.addSchema({ ...spec, $id: 'https://solventa.test/devices' });
  const validate = ajv.getSchema('https://solventa.test/devices#/components/schemas/Device'); assert.ok(validate);
  const identity = { providerSubject: 'user_synthetic', sessionReference: 'session_synthetic', emailVerified: true };
  const calls: string[] = [];
  const store = new InMemoryDeviceStore({ observedAt: 60_000, session: { clientActive: true, createdAt: 0, expiresAt: 120_000, revoked: false }, bindings: [] });
  const app = createHttp({ authentication: unexpectedAuthentication, authorizeApiAccess: async () => ({ allowed: false, status: 401, error: 'unauthorized' }),
    devices: new RegisteredDevices({ execute: async (input, decide) => {
      assert.deepEqual(input.identity, identity); assert.equal(input.installationId, installationId);
      const result = await store.execute(input, decide);
      if (result) calls.push(result.status);
      return result;
    } }),
    mobile: { configuration: config, provider: { authenticate: async () => identity, revoke: async () => { calls.push('providerRevoke'); } },
      sessions: new MobileSessions({ register: async () => principal, find: async () => principal, revokeOrBlock: async () => {} }) } });
  const legacyConfiguration = ajv.compile(JSON.parse(readFileSync('tests/fixtures/mobile-configuration-v1.1.schema.json', 'utf8')));
  const configuration = await app.request('https://synthetic.example/api/v1/mobile/config');
  assert.equal(configuration.status, 200);
  assert.ok(legacyConfiguration(await configuration.json()), JSON.stringify(legacyConfiguration.errors));
  for (const method of ['POST', 'GET', 'DELETE']) {
    const response = await app.request(`https://synthetic.example/api/v1/mobile/devices/${installationId}`, { method, headers: { Authorization: 'Bearer synthetic.jwt.token' } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(validate(await response.json()), JSON.stringify(validate.errors));
  }
  assert.deepEqual(calls, ['active', 'active', 'revoked', 'providerRevoke']);
  calls.length = 0;
  for (const [id, headers, status] of [[installationId, {}, 401], ['invalid', {}, 400], [installationId + '%0A', {}, 400], [installationId, { Cookie: 'synthetic' }, 400]] as const) {
    assert.equal((await app.request(`https://synthetic.example/api/v1/mobile/devices/${id}`, { headers })).status, status);
  }
  assert.deepEqual(calls, []);
});

test('registration keeps policy denial reasons private and returns unavailable when the required record fails', async () => {
  const store = new InMemoryDeviceStore({ observedAt: 660_000, session: { clientActive: true, createdAt: 0, expiresAt: 1_000_000, revoked: false }, bindings: [] });
  const app = createHttp({ authentication: unexpectedAuthentication, authorizeApiAccess: async () => ({ allowed: false, status: 401, error: 'unauthorized' }),
    devices: new RegisteredDevices(store), mobile: { configuration: config,
      provider: { authenticate: async () => ({ providerSubject: 'user_synthetic', sessionReference: 'session_synthetic', emailVerified: true }),
        revoke: async () => { throw new Error('unexpected_provider_revocation'); } },
      sessions: new MobileSessions({ register: async () => principal, find: async () => principal, revokeOrBlock: async () => {} }) } });
  const request = () => app.request(`https://synthetic.example/api/v1/mobile/devices/${installationId}`, { method: 'POST', headers: { Authorization: 'Bearer synthetic.jwt.token' } });
  const denial = await request();
  assert.equal(denial.status, 401);
  const body = await denial.json();
  assert.deepEqual(Object.keys(body).sort(), ['error', 'traceId']);
  assert.equal(body.error, 'unauthorized');
  assert.equal(store.plans[0].capture.outcome, 'registration_window_expired');
  store.failRecord = true;
  const unavailable = await request();
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error, 'access_unavailable');
  assert.equal(store.snapshot.bindings.length, 0);
});

test('device HTTP accepts UUID case variants and returns canonical installation and request traces', async () => {
  const upper = 'ABCDEF12-3456-4789-8ABC-DEF012345678';
  const store = new InMemoryDeviceStore({ observedAt: 60_000, session: { clientActive: true, createdAt: 0, expiresAt: 120_000, revoked: false }, bindings: [] });
  const app = createHttp({ authentication: unexpectedAuthentication, authorizeApiAccess: async () => ({ allowed: false, status: 401, error: 'unauthorized' }),
    devices: new RegisteredDevices(store), mobile: { configuration: config,
      provider: { authenticate: async () => ({ providerSubject: 'user_synthetic', sessionReference: 'session_synthetic', emailVerified: true }), revoke: async () => {} },
      sessions: new MobileSessions({ register: async () => principal, find: async () => principal, revokeOrBlock: async () => {} }) } });
  let id: string | undefined;
  for (const [method, installation] of [['POST', upper], ['POST', upper.toLowerCase()], ['GET', upper], ['DELETE', upper.toLowerCase()]]) {
    const response = await app.request(`https://synthetic.example/api/v1/mobile/devices/${installation}`, { method, headers: { Authorization: 'Bearer synthetic.jwt.token', 'X-Trace-Id': upper } });
    assert.equal(response.status, 200);
    const body = await response.json();
    id ??= body.device.id;
    assert.equal(body.device.id, id);
    assert.equal(body.device.installationId, upper.toLowerCase());
    assert.equal(body.traceId, upper.toLowerCase());
    assert.equal(response.headers.get('x-trace-id'), body.traceId);
  }
  assert.equal(store.snapshot.bindings.length, 1);
  assert.ok(store.plans.every(plan => plan.decision.effect !== 'deny'));
});


test('device DELETE retries provider revocation after the owner is suspended', async () => {
  const store = new InMemoryDeviceStore({ observedAt: 60_000, session: { clientActive: true, createdAt: 0, expiresAt: 120_000, revoked: false }, bindings: [] });
  let providerCalls = 0;
  const app = createHttp({ authentication: unexpectedAuthentication, authorizeApiAccess: async () => ({ allowed: false, status: 401, error: 'unauthorized' }),
    devices: new RegisteredDevices(store), mobile: { configuration: config,
      provider: { authenticate: async () => ({ providerSubject: 'user_synthetic', sessionReference: 'session_synthetic', emailVerified: true }),
        revoke: async () => { if (++providerCalls === 1) throw new Error('provider_unavailable'); } },
      sessions: new MobileSessions({ register: async () => principal, find: async () => principal, revokeOrBlock: async () => {} }) } });
  const request = (method: string) => app.request(`https://synthetic.example/api/v1/mobile/devices/${installationId}`, { method, headers: { Authorization: 'Bearer synthetic.jwt.token' } });
  assert.equal((await request('POST')).status, 200);
  assert.equal((await request('DELETE')).status, 503);
  assert.ok(store.snapshot.session); store.snapshot.session.clientActive = false;
  assert.equal((await request('GET')).status, 401);
  assert.equal((await request('POST')).status, 401);
  const retry = await request('DELETE');
  assert.equal(retry.status, 200); assert.equal((await retry.json()).device.status, 'revoked');
  assert.equal(providerCalls, 2);
  assert.equal(store.plans.filter(plan => plan.decision.effect === 'revoke').length, 1);
});
