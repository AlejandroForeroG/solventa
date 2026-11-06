import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiAccess, type ClaimsOperation } from '../backend/identity-consent-ecosystem/src/application/api-access';
import { changeClaimsGrant, validateClaimsGrantInput } from '../infra/claims-access.mjs';

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

// CockroachDB returns a UUID column in canonical lowercase whatever case it was inserted with.
function ledger() {
  let stored: Record<string, unknown> | null = null;
  return {
    async query(sql: string, params: unknown[] = []) {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM identity.clients')) return { rows: [{ id: String(params[0]).toLowerCase() }], rowCount: 1 };
      if (sql.includes('SELECT client_id,operation')) return { rows: stored ? [stored] : [], rowCount: stored ? 1 : 0 };
      if (sql.includes('INSERT INTO identity.claims_access_grants')) {
        stored = { client_id: String(params[1]).toLowerCase(), operation: params[2], expires_at: new Date(String(params[3])), granted_by: params[4], revoked_at: null };
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO identity.audit_events')) return { rows: [], rowCount: 1 };
      throw new Error('unexpected SQL: ' + sql);
    }
  };
}
const grantInput = (change: Record<string, string> = {}) => ({ grantId: '90000000-0000-4000-8000-0000000000A1', clientId: '90000000-0000-4000-8000-0000000000B1', operation: 'claims:read',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(), operatorReference: '90000000-0000-4000-8000-0000000000C1', ...change });

test('an identical retry of a grant stays a no-op even when the UUIDs were written in uppercase', async () => {
  const db = ledger();
  const input = grantInput();
  assert.equal((await changeClaimsGrant(db, 'local', 'grant', input)).changed, true);
  assert.equal((await changeClaimsGrant(db, 'local', 'grant', input)).changed, false);
  assert.equal((await changeClaimsGrant(db, 'local', 'grant', { ...input, clientId: input.clientId.toLowerCase() })).changed, false);
});

test('a retry that changes the client, operation, expiry or operator still conflicts', async () => {
  const db = ledger();
  const input = grantInput();
  await changeClaimsGrant(db, 'local', 'grant', input);
  for (const change of [{ clientId: '90000000-0000-4000-8000-0000000000B2' }, { operation: 'claims:decide' }, { expiresAt: new Date(Date.now() + 7_200_000).toISOString() },
    { operatorReference: '90000000-0000-4000-8000-0000000000C2' }]) {
    await assert.rejects(changeClaimsGrant(db, 'local', 'grant', { ...input, ...change }), /grant_id_conflict/);
  }
});

test('grant inputs are canonicalized and anything else is rejected', () => {
  const clean = validateClaimsGrantInput('local', 'grant', grantInput());
  assert.equal(clean.clientId, '90000000-0000-4000-8000-0000000000b1');
  assert.equal(clean.grantId, '90000000-0000-4000-8000-0000000000a1');
  for (const bad of [{ operation: 'claims:other' }, { clientId: 'not-a-uuid' }, { expiresAt: '2026-01-01' }]) assert.throws(() => validateClaimsGrantInput('local', 'grant', grantInput(bad)));
  assert.throws(() => validateClaimsGrantInput('local', 'grant', { ...grantInput(), extra: 'field' }));
});
