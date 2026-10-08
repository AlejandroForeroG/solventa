import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiAccess, type PartnerCredential, type PartnerAccessRepository } from '../backend/identity-consent-ecosystem/src/application/api-access';
import type { IdentitySessions } from '../backend/identity-consent-ecosystem/src/application/authentication';
import { validatePartnerAccessInput } from '../infra/partner-access.mjs';

const identity = { issuer: 'https://synthetic.authkit.app', organizationId: 'org_synthetic', applicationId: 'client_synthetic', scopes: ['quotes:create', 'unrecognized'] };
const webIdentity = { providerSubject: 'user_synthetic', sessionReference: 'session_synthetic', emailVerified: true };
const principal = { clientId: 'client-internal', subjectToken: 'subject-opaque' };
const credential = { partnerId: 'partner-internal', credentialId: 'credential-internal', scopes: ['quotes:create', 'unrecognized'] };
const sessions: IdentitySessions = { open: async () => principal, find: async () => principal, revoke: async () => {} };

test('partner access binds issuer, organization and application and intersects scopes', async () => {
  let lookup: string[] = [];
  const api = new ApiAccess({ find: async (provider, reference) => { lookup = [provider, reference]; return credential; } }, sessions);
  assert.deepEqual(await api.partner(identity, 'quotes:create'), { allowed: true, actor: { kind: 'partner', partnerId: credential.partnerId, credentialId: credential.credentialId, scopes: ['quotes:create'] } });
  assert.deepEqual(lookup, ['workos-connect', JSON.stringify([identity.issuer, identity.organizationId, identity.applicationId])]);
  assert.deepEqual(await api.partner({ ...identity, scopes: ['unrecognized'] }, 'quotes:create'), { allowed: false, error: 'forbidden', status: 403 });
});

test('no active registration or absent SQL scope denies a valid partner identity', async () => {
  for (const row of [null, { ...credential, scopes: ['unrecognized'] }]) {
    const api = new ApiAccess({ find: async () => row }, sessions);
    assert.deepEqual(await api.partner(identity, 'quotes:create'), { allowed: false, error: 'forbidden', status: 403 });
  }
});

test('different issuer, organization or application cannot reuse a registration', async () => {
  const reference = JSON.stringify([identity.issuer, identity.organizationId, identity.applicationId]);
  const repository: PartnerAccessRepository = { find: async (_, candidate) => candidate === reference ? credential : null };
  const api = new ApiAccess(repository, sessions);
  for (const variation of [{ issuer: 'https://another.authkit.app' }, { organizationId: 'org_another' }, { applicationId: 'client_another' }]) {
    assert.deepEqual(await api.partner({ ...identity, ...variation }, 'quotes:create'), { allowed: false, error: 'forbidden', status: 403 });
  }
});

test('unknown operations never reach repository or session storage', async () => {
  const fail = async (): Promise<PartnerCredential | null> => { throw Error('unexpected_lookup'); };
  const api = new ApiAccess({ find: fail }, { ...sessions, find: async () => { assert.fail('unexpected_session_lookup'); } });
  for (const scope of ['', 'quotes:read', '*', 'QUOTES:CREATE']) {
    assert.deepEqual(await api.partner(identity, scope), { allowed: false, error: 'invalid_request', status: 400 });
    assert.deepEqual(await api.web(webIdentity, 'dev', scope, 'dev:v1'), { allowed: false, error: 'invalid_request', status: 400 });
  }
});

test('web uses its explicit environment channel and current local principal', async () => {
  let lookup: string[] = [];
  const api = new ApiAccess({ find: async (provider, reference) => { lookup = [provider, reference]; return credential; } }, sessions);
  assert.deepEqual(await api.web(webIdentity, 'dev', 'quotes:create', 'dev:v1'), { allowed: true, actor: { kind: 'web', partnerId: credential.partnerId, credentialId: credential.credentialId, scopes: ['quotes:create'], principal } });
  assert.deepEqual(lookup, ['solventa-web', 'dev:v1']);
  assert.deepEqual(await api.web(webIdentity, 'unknown', 'quotes:create', 'unknown:v1'), { allowed: false, error: 'access_unavailable', status: 503 });
});

test('web rejects missing, unversioned and cross-environment channel configuration before storage', async () => {
  let lookups = 0;
  const api = new ApiAccess({ find: async () => { lookups++; return credential; } }, { ...sessions, find: async () => { lookups++; return principal; } });
  for (const reference of ['', 'dev', 'prod:v1', 'dev:', 'dev:V1', 'dev:../v1', 'dev:v1 ', `dev:${'a'.repeat(65)}`]) {
    assert.deepEqual(await api.web(webIdentity, 'dev', 'quotes:create', reference), { allowed: false, error: 'access_unavailable', status: 503 });
  }
  assert.equal(lookups, 0);
  assert.equal((await api.web(webIdentity, 'dev', 'quotes:create', `dev:${'a'.repeat(64)}`)).allowed, true);
});

test('web rotation selects only the configured version and never falls back to a revoked credential', async () => {
  const api = new ApiAccess({ find: async (_, reference) => reference === 'dev:v2' ? credential : null }, sessions);
  assert.deepEqual(await api.web(webIdentity, 'dev', 'quotes:create', 'dev:v1'), { allowed: false, error: 'forbidden', status: 403 });
  assert.equal((await api.web(webIdentity, 'dev', 'quotes:create', 'dev:v2')).allowed, true);
});

test('web session failure denies before checking channel and channel absence does not auto-register', async () => {
  let lookups = 0;
  const repository = { find: async () => { lookups++; return null; } };
  const api = new ApiAccess(repository, { ...sessions, find: async () => null });
  assert.deepEqual(await api.web(webIdentity, 'dev', 'quotes:create', 'dev:v1'), { allowed: false, error: 'unauthorized', status: 401 });
  assert.deepEqual(await api.web({ ...webIdentity, emailVerified: false }, 'dev', 'quotes:create', 'dev:v1'), { allowed: false, error: 'unauthorized', status: 401 });
  assert.equal(lookups, 0);
  assert.deepEqual(await new ApiAccess(repository, sessions).web(webIdentity, 'dev', 'quotes:create', 'dev:v1'), { allowed: false, error: 'forbidden', status: 403 });
  assert.equal(lookups, 1);
});

test('dependency failures become unavailable without exposing database errors', async () => {
  const repository = { find: async () => { throw Error('sensitive connection detail'); } };
  assert.deepEqual(await new ApiAccess(repository, sessions).partner(identity, 'quotes:create'), { allowed: false, error: 'access_unavailable', status: 503 });
  assert.deepEqual(await new ApiAccess(repository, sessions).web(webIdentity, 'dev', 'quotes:create', 'dev:v1'), { allowed: false, error: 'access_unavailable', status: 503 });
  const brokenSessions = { ...sessions, find: async () => { throw Error('sensitive SQL detail'); } };
  assert.deepEqual(await new ApiAccess({ find: async () => credential }, brokenSessions).web(webIdentity, 'dev', 'quotes:create', 'dev:v1'), { allowed: false, error: 'access_unavailable', status: 503 });
});

const now = Date.parse('2026-01-01T00:00:00Z');
const registration = { partnerCode: 'synthetic-partner', provider: 'workos-connect', reference: JSON.stringify([identity.issuer, identity.organizationId, identity.applicationId]), scopes: ['quotes:create'], expiresAt: '2099-01-01T00:00:00Z' };
test('operator input validates reference, explicit environment, bounded fields, scopes and real future date', () => {
  assert.deepEqual(validatePartnerAccessInput('dev', 'register', registration, now), registration);
  assert.doesNotThrow(() => validatePartnerAccessInput('dev', 'register', { ...registration, expiresAt: '2099-01-01T00:00:00.123Z' }, now));
  assert.doesNotThrow(() => validatePartnerAccessInput('dev', 'register', { ...registration, provider: 'solventa-web', reference: 'dev:v1' }, now));
  for (const reference of ['dev', 'prod:v1', 'dev:', 'dev:V1', 'dev:../v1', `dev:${'a'.repeat(65)}`]) {
    assert.throws(() => validatePartnerAccessInput('dev', 'register', { ...registration, provider: 'solventa-web', reference }, now), /invalid_reference/);
    assert.throws(() => validatePartnerAccessInput('dev', 'revoke', { provider: 'solventa-web', reference }, now), /invalid_reference/);
  }
  assert.doesNotThrow(() => validatePartnerAccessInput('dev', 'revoke', { provider: 'solventa-web', reference: 'dev:v1' }, now));
  const invalidInputs = [null, [], { ...registration, typo: true }, { ...registration, partnerCode: '../bad' }, { ...registration, scopes: ['quotes:create', '*'] }, { ...registration, scopes: [] }, { ...registration, expiresAt: '2099-02-30T00:00:00Z' }, { ...registration, expiresAt: '2025-01-01T00:00:00Z' }, { ...registration, provider: 'solventa-web', reference: 'prod' }, { ...registration, reference: 'x'.repeat(2049) }, { ...registration, reference: JSON.stringify(['https://synthetic.authkit.app.attacker.invalid', 'org', 'app']) }, { ...registration, reference: JSON.stringify(['https://user:password@synthetic.authkit.app', 'org', 'app']) }, { ...registration, reference: JSON.stringify(['https://synthetic.authkit.app', '', 'app']) }, { ...registration, reference: JSON.stringify(['https://synthetic.authkit.app/', 'org', 'app']) }];
  for (const input of invalidInputs) assert.throws(() => validatePartnerAccessInput('dev', 'register', input, now));
  assert.throws(() => validatePartnerAccessInput('unknown', 'register', registration, now), /invalid_command/);
  assert.throws(() => validatePartnerAccessInput('dev', 'activate', registration, now), /invalid_command/);
  assert.doesNotThrow(() => validatePartnerAccessInput('dev', 'revoke', { provider: registration.provider, reference: registration.reference }, now));
  assert.throws(() => validatePartnerAccessInput('dev', 'revoke', registration, now), /invalid_input/);
});
