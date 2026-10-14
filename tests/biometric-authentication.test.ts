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
  const apply = async (input: { identity: typeof identity; installationId: string }, status: 'active' | 'revoked') => {
    assert.deepEqual(input.identity, identity); assert.equal(input.installationId, installationId);
    calls.push(status); return { id: principal.clientId, installationId, status };
  };
  const app = createHttp({ authentication: unexpectedAuthentication, authorizeApiAccess: async () => ({ allowed: false, status: 401, error: 'unauthorized' }),
    devices: new RegisteredDevices({ register: input => apply(input, 'active'), find: input => apply(input, 'active'), revoke: input => apply(input, 'revoked') }),
    mobile: { configuration: config, provider: { authenticate: async () => identity, revoke: async () => { calls.push('providerRevoke'); } },
      sessions: new MobileSessions({ register: async () => principal, find: async () => principal, revokeOrBlock: async () => {} }) } });
  for (const method of ['POST', 'GET', 'DELETE']) {
    const response = await app.request(`https://synthetic.example/api/v1/mobile/devices/${installationId}`, { method, headers: { Authorization: 'Bearer synthetic.jwt.token' } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(validate(await response.json()), JSON.stringify(validate.errors));
  }
  assert.deepEqual(calls, ['active', 'active', 'revoked', 'providerRevoke']);
  calls.length = 0;
  for (const [id, headers, status] of [[installationId, {}, 401], ['invalid', {}, 400], [installationId, { Cookie: 'synthetic' }, 400]] as const) {
    assert.equal((await app.request(`https://synthetic.example/api/v1/mobile/devices/${id}`, { headers })).status, status);
  }
  assert.deepEqual(calls, []);
});
