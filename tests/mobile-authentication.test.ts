import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import type { User } from '@workos-inc/node';
import { WorkosMobileAuthentication } from '../backend/identity-consent-ecosystem/src/adapters/outbound/workos-mobile-authentication';
import { MobileSessions } from '../backend/identity-consent-ecosystem/src/application/mobile-sessions';
import { ApiAccess } from '../backend/identity-consent-ecosystem/src/application/api-access';
import { authorizeApiAccess } from '../backend/identity-consent-ecosystem/src/adapters/inbound/api-access-http';

const clientId = 'client_mobileTest';
const issuer = `https://api.workos.com/user_management/${clientId}`;
const pair = generateKeyPair('RS256');
const otherPair = generateKeyPair('RS256');
const now = Math.floor(Date.now() / 1000);
const user: User = { object: 'user', id: 'user_synthetic', email: 'synthetic@solventa.invalid', emailVerified: true,
  profilePictureUrl: null, firstName: null, lastName: null, lastSignInAt: null, externalId: null,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} };
const identity = { providerSubject: user.id, sessionReference: 'session_synthetic', emailVerified: true };
const principal = { clientId: crypto.randomUUID(), subjectToken: crypto.randomUUID() };
const claims = { iss: issuer, client_id: clientId, sub: user.id, sid: identity.sessionReference, iat: now, exp: now + 300 };
const token = async (overrides: Record<string, unknown> = {}, key?: CryptoKey) => new SignJWT({ ...claims, ...overrides }).setProtectedHeader({ alg: 'RS256', typ: 'JWT' }).sign(key ?? (await pair).privateKey);
function adapter(getUser = async () => user) {
  return new WorkosMobileAuthentication({ clientId, apiKey: 'synthetic-unused' }, {
    keys: async () => (await pair).publicKey,
    provider: { getUser, revokeSession: async () => {} },
  });
}

test('native user verification derives identity from a signed environment-bound token and a verified provider account', async () => {
  assert.deepEqual(await adapter().authenticate(await token()), identity);
});
const invalidClaims = [
  { iss: 'https://foreign.authkit.app' }, { client_id: 'client_foreign' }, { aud: 'client_foreign' },
  { sub: 'connect_app_synthetic', sid: undefined }, { sub: 'client_partner' }, { sid: 'foreign' },
  { sub: undefined }, { sid: undefined }, { client_id: undefined }, { iat: undefined }, { exp: undefined },
  { iat: now + 60 }, { exp: now - 1 }, { iat: 1.5 }, { exp: now + 0.5 }, { act: { sub: 'user_operator' } },
];
for (const overrides of invalidClaims) {
  test(`native verification denies changed claims ${JSON.stringify(overrides)}`, async () => {
    let consulted = false;
    const auth = adapter(async () => { consulted = true; return user; });
    assert.equal(await auth.authenticate(await token(overrides)), null);
    assert.equal(consulted, false);
  });
}
test('bad signatures, malformed and oversized tokens never consult the provider account', async () => {
  let consulted = false;
  const auth = adapter(async () => { consulted = true; return user; });
  for (const value of ['wrong', 'a'.repeat(8193), await token({}, (await otherPair).privateKey)]) assert.equal(await auth.authenticate(value), null);
  assert.equal(consulted, false);
});
test('unverified and deleted accounts are denied; provider or key retrieval failures remain unavailable', async () => {
  const value = await token();
  assert.equal(await adapter(async () => ({ ...user, emailVerified: false })).authenticate(value), null);
  assert.equal(await adapter(async () => { throw { status: 404 }; }).authenticate(value), null);
  await assert.rejects(adapter(async () => { throw new Error('provider_offline'); }).authenticate(value), /provider_offline/);
  const auth = new WorkosMobileAuthentication({ clientId, apiKey: 'synthetic' }, {
    keys: async () => { throw new Error('keys_offline'); }, provider: { getUser: async () => user, revokeSession: async () => {} },
  });
  await assert.rejects(auth.authenticate(value), /mobile_identity_provider_unavailable/);
});
test('mobile session registration requires a verified identity and permission lookup never registers or refreshes', async () => {
  let registered = 0;
  const store = { register: async () => { registered++; return principal; }, find: async () => principal, revoke: async () => {}, revokeOrBlock: async () => {} };
  const sessions = new MobileSessions(store);
  assert.equal(await sessions.register({ ...identity, emailVerified: false }), null);
  assert.equal(registered, 0);
  assert.deepEqual(await sessions.register(identity), principal);
  const access = new ApiAccess({ find: async () => { throw new Error('partner_lookup'); } }, { ...store, open: async () => { throw new Error('registration'); } });
  const decision = await authorizeApiAccess({ application: access, partner: null, web: null,
    mobile: { authenticate: async () => identity, authorize: (verified, operation) => access.mobileUser(verified, operation) },
  }, { kind: 'mobile', token: 'synthetic.jwt.token', operation: 'quotes:create' });
  assert.deepEqual(decision, { allowed: true, actor: { kind: 'user', channel: 'mobile', principal, operations: ['quotes:create'] } });
  assert.equal(registered, 1);
  assert.deepEqual(await access.mobileUser(identity, 'consents:write'), { allowed: false, status: 403, error: 'forbidden' });
});

test('native logout delegates one atomic blocking operation without active registration', async () => {
  const calls: string[] = [];
  const sessions = new MobileSessions({
    register: async () => { throw new Error('logout_must_not_register'); },
    find: async () => null,
    revokeOrBlock: async verified => { assert.deepEqual(verified, identity); calls.push('block'); },
  });
  await sessions.revoke(identity);
  assert.deepEqual(calls, ['block']);
});
test('unregistered or revoked local mobile sessions cannot authorize; database outages fail closed', async () => {
  const store = { open: async () => principal, find: async () => null, revoke: async () => {} };
  const access = new ApiAccess({ find: async () => null }, store);
  assert.deepEqual(await access.mobileUser(identity, 'quotes:create'), { allowed: false, error: 'unauthorized', status: 401 });
  const unavailable = new ApiAccess({ find: async () => null }, { ...store, find: async () => { throw new Error('offline'); } });
  assert.deepEqual(await unavailable.mobileUser(identity, 'quotes:create'), { allowed: false, error: 'access_unavailable', status: 503 });
});
