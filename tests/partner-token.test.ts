import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, errors, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { JWTPayload } from 'jose';
import { WorkosPartnerAuthentication } from '../backend/identity-consent-ecosystem/src/adapters/outbound/workos-partner-authentication';

const config = { issuer: 'https://synthetic.authkit.app', audience: 'client_solventa' };
const keyPair = generateKeyPair('RS256');
async function fixture() {
  const { publicKey, privateKey } = await keyPair;
  const jwk = await exportJWK(publicKey);
  const resolver = createLocalJWKSet({ keys: [{ ...jwk, kid: 'synthetic-key', alg: 'RS256', use: 'sig' }] });
  const provider = new WorkosPartnerAuthentication(config, resolver);
  const now = Math.floor(Date.now() / 1000);
  const claims: JWTPayload = {
    iss: config.issuer, aud: config.audience, sub: 'client_partner', client_id: 'client_partner',
    org_id: 'org_partner', scope: 'quotes:create quotes:read', jti: 'synthetic-event', iat: now - 10, exp: now + 300,
  };
  const sign = (payload: Record<string, unknown> = claims, header: { alg: string; typ?: string; kid?: string } = { alg: 'RS256', kid: 'synthetic-key', typ: 'JWT' }) =>
    new SignJWT(payload).setProtectedHeader(header).sign(privateKey);
  return { provider, claims, sign, privateKey };
}

test('M2M verification returns only its validated identity and scopes', async () => {
  const { provider, claims, sign } = await fixture();
  assert.deepEqual(await provider.authenticate(await sign()), {
    issuer: config.issuer, applicationId: 'client_partner', organizationId: 'org_partner', scopes: ['quotes:create', 'quotes:read'],
  });
  assert.deepEqual((await provider.authenticate(await sign({ ...claims, scope: '' })))?.scopes, []);
  assert.deepEqual((await provider.authenticate(await sign({ ...claims, scope: 'quotes:create quotes:create' })))?.scopes, ['quotes:create']);
  assert.ok(await provider.authenticate(await sign(claims, { alg: 'RS256', kid: 'synthetic-key' })));
});

test('M2M tokens must belong to this issuer and audience, with valid times and signature', async () => {
  const { provider, claims, sign } = await fixture();
  for (const change of [
    { iss: 'https://other.authkit.app' }, { aud: 'client_other' }, { exp: 1 },
    { iat: Math.floor(Date.now() / 1000) + 600 }, { iat: -1 }, { iat: claims.exp },
    { nbf: Math.floor(Date.now() / 1000) + 600 },
  ]) assert.equal(await provider.authenticate(await sign({ ...claims, ...change })), null);
  const otherKey = await generateKeyPair('RS256');
  const forged = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' }).sign(otherKey.privateKey);
  assert.equal(await provider.authenticate(forged), null);
  assert.equal(await provider.authenticate(await sign(claims, { alg: 'RS256', kid: 'unknown-key' })), null);
});

test('user tokens, other token types and unsupported algorithms cannot authenticate a partner', async () => {
  const { provider, claims, sign } = await fixture();
  for (const change of [{ sub: 'user_someone' }, { client_id: 'client_other' }, { sid: 'session_user' }, { sid: null }]) {
    assert.equal(await provider.authenticate(await sign({ ...claims, ...change })), null);
  }
  assert.equal(await provider.authenticate(await sign(claims, { alg: 'RS256', kid: 'synthetic-key', typ: 'refresh+jwt' })), null);
  const hs = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).sign(crypto.getRandomValues(new Uint8Array(32)));
  assert.equal(await provider.authenticate(hs), null);
});

test('required claims and OAuth scope syntax are validated without trusting client JSON', async () => {
  const { provider, claims, sign } = await fixture();
  for (const name of ['iss', 'aud', 'sub', 'client_id', 'org_id', 'exp', 'iat', 'jti', 'scope']) {
    const missing = { ...claims };
    delete missing[name];
    assert.equal(await provider.authenticate(await sign(missing)), null, `missing ${name}`);
  }
  for (const change of [
    { scope: ['quotes:create'] }, { scope: null }, { scope: 'quotes:create\tadmin' }, { scope: 'quotes:create  admin' },
    { scope: 'quotes:create\nadmin' }, { scope: 'quotes:create\n' }, { client_id: 1 },
    { client_id: 'client_partner\n', sub: 'client_partner\n' }, { org_id: '' }, { org_id: 'org_partner\n' }, { org_id: 'org_invalid/path' },
    { jti: '' }, { jti: 1 }, { iat: '1' }, { exp: '2' },
  ]) assert.equal(await provider.authenticate(await sign({ ...claims, ...change })), null);
});

test('malformed and oversized tokens are denied without calling the key resolver', async () => {
  let called = false;
  const provider = new WorkosPartnerAuthentication(config, async () => { called = true; throw new Error('unexpected_key_lookup'); });
  for (const token of ['', 'invalid', 'a.b.c\n', 'a'.repeat(8193), 'a.b.']) assert.equal(await provider.authenticate(token), null);
  assert.equal(called, false);
});

test('JWKS provider failure remains unavailable instead of becoming an invalid credential', async () => {
  const { sign } = await fixture();
  for (const failure of [new errors.JWKSTimeout(), new errors.JWKSInvalid('invalid set'), new Error('network_failed')]) {
    const provider = new WorkosPartnerAuthentication(config, async () => { throw failure; });
    await assert.rejects(provider.authenticate(await sign()), { message: 'partner_identity_provider_unavailable', cause: failure });
  }
});

test('issuer configuration cannot direct JWKS to arbitrary or credential-bearing URLs', () => {
  for (const issuer of [
    'http://synthetic.authkit.app', 'https://authkit.app', 'https://synthetic.authkit.app.attacker.invalid',
    'https://user:secret@synthetic.authkit.app', 'https://synthetic.authkit.app/path',
    'https://synthetic.authkit.app?query=1', 'https://synthetic.authkit.app#fragment',
    'https://synthetic.authkit.app:8443', 'https://synthetic.authkit.app/', 'invalid',
  ]) assert.throws(() => new WorkosPartnerAuthentication({ ...config, issuer }));
  assert.throws(() => new WorkosPartnerAuthentication({ ...config, audience: '' }), /invalid_partner_audience/);
});
