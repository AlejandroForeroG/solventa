import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { createHttp } from '../backend/identity-consent-ecosystem/src/adapters/inbound/http';
import { ApiAccess } from '../backend/identity-consent-ecosystem/src/application/api-access';
import { NotificationPreferences } from '../backend/identity-consent-ecosystem/src/application/notification-preferences';
import { MobileSessions } from '../backend/identity-consent-ecosystem/src/application/mobile-sessions';
import type { NotificationPreferenceStore, NotificationPreferencesView } from '../backend/identity-consent-ecosystem/src/application/notification-preferences';
import { defaultNotificationMatrix, NotificationPreferenceFailure } from '../backend/identity-consent-ecosystem/src/domain/notification-preferences';
import { createPreferencesApi } from '../apps/mobile/src/features/notification-preferences/adapters/preferences-api';
import { unexpectedAuthentication } from './support/authentication-fakes';

const spec = parse(readFileSync('packages/contracts/openapi/v1/notification-preferences.yaml', 'utf8'));
const ajv = new Ajv({ strict: false });
addFormats(ajv);
const schemaId = 'https://solventa.test/notification-preferences.yaml';
ajv.addSchema({ ...spec, $id: schemaId });
const owner = { providerSubject: 'synthetic-owner', sessionReference: 'synthetic-session', emailVerified: true };
const other = { providerSubject: 'synthetic-other', sessionReference: 'synthetic-other-session', emailVerified: true };
const principals = new Map([[owner.providerSubject, { clientId: randomUUID(), subjectToken: randomUUID() }],
  [other.providerSubject, { clientId: randomUUID(), subjectToken: randomUUID() }]]);

function setup() {
  const records = new Map<string, NotificationPreferencesView>();
  const commands = new Map<string, { hash: string; result: NotificationPreferencesView }>();
  const flags = { failWrite: false, failDenial: false };
  const store: NotificationPreferenceStore = {
    async read(clientId) { return structuredClone(records.get(clientId) ?? null); },
    async save(input) {
      if (flags.failWrite) throw new Error('synthetic_db_unavailable');
      const key = `${input.clientId}:${input.key}`;
      const previous = commands.get(key);
      if (previous) {
        if (previous.hash !== input.requestHash) throw new NotificationPreferenceFailure('conflict', 409);
        return structuredClone(previous.result);
      }
      const current = records.get(input.clientId);
      if ((current?.version ?? 0) !== input.expectedVersion) throw new NotificationPreferenceFailure('conflict', 409);
      const result = { version: input.expectedVersion + 1, preferences: structuredClone(input.preferences) };
      records.set(input.clientId, result); commands.set(key, { hash: input.requestHash, result });
      return structuredClone(result);
    },
  };
  const access = new ApiAccess({ find: async () => null }, {
    find: async identity => principals.get(identity.providerSubject) ?? null,
    open: async () => { throw new Error('unexpected'); }, revoke: async () => { throw new Error('unexpected'); },
  });
  const denials: string[] = [];
  const app = createHttp({ authentication: unexpectedAuthentication,
    authorizeApiAccess: async () => ({ allowed: false, error: 'forbidden', status: 403 }),
    notificationPreferences: new NotificationPreferences(store),
    verificationAccess: (identity, operation) => access.mobileUser(identity, operation),
    mobile: { configuration: { clientId: 'client_synthetic', redirectUri: 'solventa://auth/callback' },
      provider: { authenticate: async token => token === 'synthetic.owner' ? owner : token === 'synthetic.other' ? other : null,
        revoke: async () => {} },
      sessions: new MobileSessions({ find: async identity => principals.get(identity.providerSubject) ?? null,
        register: async () => { throw new Error('unexpected'); },
        revokeOrBlock: async () => { throw new Error('unexpected'); } }) },
    security: { deny: async decision => { if (flags.failDenial) throw new Error('synthetic_audit_failure'); denials.push(decision.cause); } },
  });
  async function call(method = 'GET', body?: unknown, token = 'synthetic.owner', key = randomUUID()) {
    const response = await app.request('https://dev.solventa.site/api/v1/mobile/notification-preferences', {
      method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    const validate = ajv.getSchema(`${schemaId}#/components/schemas/${response.ok ? 'PreferencesEnvelope' : 'Error'}`)!;
    assert.equal(validate(data), true, JSON.stringify(validate.errors));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-trace-id'), data.traceId);
    return { response, data };
  }
  return { call, records, commands, flags, denials, app };
}

test('native customer reads defaults, saves category consent and replays one committed mutation', async () => {
  const f = setup();
  const first = await f.call();
  assert.equal(first.data.preferences.version, 0);
  assert.deepEqual(first.data.preferences.preferences, defaultNotificationMatrix);
  const matrix = structuredClone(defaultNotificationMatrix); matrix.policy.push = true;
  const key = randomUUID();
  const saved = await f.call('PUT', { expectedVersion: 0, preferences: matrix }, 'synthetic.owner', key);
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.preferences.version, 1);
  assert.equal((await f.call('PUT', { expectedVersion: 0, preferences: matrix }, 'synthetic.owner', key)).data.preferences.version, 1);
  assert.equal(f.commands.size, 1);
  assert.equal((await f.call()).data.preferences.preferences.policy.push, true);
  assert.deepEqual((await f.call('GET', undefined, 'synthetic.other')).data.preferences.preferences, defaultNotificationMatrix);
  assert.equal((await f.call('PUT', { expectedVersion: 0, preferences: matrix })).response.status, 409);
  matrix.policy.email = true;
  assert.equal((await f.call('PUT', { expectedVersion: 0, preferences: matrix }, 'synthetic.owner', key)).response.status, 409);
});

test('invalid matrix, missing authorization and failed persistence do not create choices', async () => {
  const f = setup();
  assert.equal((await f.call('PUT', { expectedVersion: 0, preferences: { policy: {} } })).response.status, 400);
  assert.equal((await f.call('GET', undefined, 'bad.token')).response.status, 401);
  assert.deepEqual(f.denials, ['unauthorized']);
  f.flags.failDenial = true;
  assert.equal((await f.call('GET', undefined, 'bad.token')).response.status, 503);
  f.flags.failDenial = false; f.flags.failWrite = true;
  assert.equal((await f.call('PUT', { expectedVersion: 0, preferences: defaultNotificationMatrix })).response.status, 503);
  assert.equal(f.records.size, 0);
});

test('mobile adapter reads and saves through the real HTTP handler without cookies', async () => {
  const f = setup();
  const request: typeof fetch = async (url, options) => {
    assert.equal(options?.credentials, 'omit');
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer synthetic.owner');
    return f.app.request(new Request(url, options));
  };
  const api = createPreferencesApi('https://dev.solventa.site', { execute: operation => operation('synthetic.owner') }, request);
  const current = await api.read();
  const matrix = structuredClone(current.preferences); matrix.commercial.email = true;
  const saved = await api.save(matrix, current.version, randomUUID());
  assert.equal(saved.preferences.commercial.email, true);
  assert.equal((await api.read()).version, 1);
});

test('published response example conforms to the public schema', () => {
  const example = JSON.parse(readFileSync('packages/contracts/examples/notification-preferences.json', 'utf8'));
  const validate = ajv.getSchema(`${schemaId}#/components/schemas/PreferencesEnvelope`)!;
  assert.equal(validate(example), true, JSON.stringify(validate.errors));
});
