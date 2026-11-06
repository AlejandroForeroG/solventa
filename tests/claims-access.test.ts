import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiAccess, type ClaimsOperation } from '../backend/identity-consent-ecosystem/src/application/api-access';

const identity = { providerSubject: 'synthetic-analyst', sessionReference: 'synthetic-session', emailVerified: true };
const principal = { clientId: '90000000-0000-4000-8000-000000000001', subjectToken: '90000000-0000-4000-8000-000000000002' };
const sessions = { find: async () => principal, open: async () => principal, revoke: async () => {} };
const partner = { find: async () => null };
const lease = () => new Date(Date.now() + 5000).toISOString();
const grantedFor = (...allowed: ClaimsOperation[]) => ({ find: async (_p: unknown, _i: unknown, operation: ClaimsOperation) => allowed.includes(operation) ? { expiresAt: lease() } : null });

test('a session alone never grants claims access, even for the audit permission holder', async () => {
  const audit = { find: async () => ({ expiresAt: lease() }) };
  const api = new ApiAccess(partner, sessions, audit);
  for (const operation of ['claims:read', 'claims:decide']) {
    assert.deepEqual(await api.webUser(identity, operation), { allowed: false, error: 'forbidden', status: 403 });
  }
});

test('each claims operation needs its own grant so reading never implies deciding', async () => {
  const api = new ApiAccess(partner, sessions, undefined, grantedFor('claims:read'));
  const read = await api.webUser(identity, 'claims:read');
  assert.equal(read.allowed, true);
  if (read.allowed) assert.deepEqual(read.actor.operations, ['claims:read']);
  assert.equal((await api.webUser(identity, 'claims:decide')).allowed, false);
  assert.equal((await new ApiAccess(partner, sessions, undefined, grantedFor('claims:decide')).webUser(identity, 'claims:read')).allowed, false);
});

test('the claims grant does not open the audit permission or the other way around', async () => {
  const claims = new ApiAccess(partner, sessions, undefined, grantedFor('claims:read', 'claims:decide'));
  assert.equal((await claims.webUser(identity, 'underwriting-decisions:read')).allowed, false);
});

test('partners and native users are denied claims operations even with a grant', async () => {
  const api = new ApiAccess(partner, sessions, undefined, grantedFor('claims:read', 'claims:decide'));
  for (const operation of ['claims:read', 'claims:decide']) {
    assert.equal((await api.mobileUser(identity, operation)).allowed, false);
    assert.equal((await api.partner({ issuer: 'https://synthetic.invalid', organizationId: 'org', applicationId: 'app', scopes: [operation] }, operation)).allowed, false);
  }
});

test('unauthenticated sessions are rejected before any grant lookup', async () => {
  const api = new ApiAccess(partner, { ...sessions, find: async () => null }, undefined, { find: async () => { assert.fail('grant before session'); } });
  assert.equal((await api.webUser(identity, 'claims:read')).status, 401);
});

test('storage failure and an unbounded lease fail closed', async () => {
  const failing = new ApiAccess(partner, sessions, undefined, { find: async () => { throw new Error('SQL unavailable'); } });
  assert.deepEqual(await failing.webUser(identity, 'claims:read'), { allowed: false, error: 'access_unavailable', status: 503 });
  const longLease = new ApiAccess(partner, sessions, undefined, { find: async () => ({ expiresAt: new Date(Date.now() + 60000).toISOString() }) });
  assert.equal((await longLease.webUser(identity, 'claims:read')).status, 503);
  const expired = new ApiAccess(partner, sessions, undefined, { find: async () => ({ expiresAt: new Date(Date.now() - 1000).toISOString() }) });
  assert.equal((await expired.webUser(identity, 'claims:read')).status, 503);
});
