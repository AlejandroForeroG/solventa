import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiAccess, type ReportOperation } from '../backend/identity-consent-ecosystem/src/application/api-access';
import { validateReportGrantInput } from '../infra/report-access.mjs';

const identity = { providerSubject: 'synthetic-operator', sessionReference: 'synthetic-session', emailVerified: true };
const principal = { clientId: '90000000-0000-4000-8000-000000000001', subjectToken: '90000000-0000-4000-8000-000000000002' };
const sessions = { find: async () => principal, open: async () => principal, revoke: async () => {} };
const partner = { find: async () => null };
const lease = () => new Date(Date.now() + 5000).toISOString();
const reportOperations: ReportOperation[] = ['reports:generate', 'reports:read', 'reports:download', 'reports:send'];
const grantedFor = (...allowed: ReportOperation[]) => ({ find: async (_p: unknown, _i: unknown, operation: ReportOperation) => allowed.includes(operation) ? { expiresAt: lease() } : null });
const withReports = (...allowed: ReportOperation[]) => new ApiAccess(partner, sessions, undefined, undefined, undefined, undefined, grantedFor(...allowed));

test('a valid session never grants a report operation, even with the audit and claims permissions', async () => {
  const everything = { find: async () => ({ expiresAt: lease() }) };
  const api = new ApiAccess(partner, sessions, everything, everything);
  for (const operation of reportOperations) assert.deepEqual(await api.webUser(identity, operation), { allowed: false, error: 'forbidden', status: 403 });
});

test('each report operation needs its own grant', async () => {
  for (const operation of reportOperations) {
    const decision = await withReports(operation).webUser(identity, operation);
    assert.equal(decision.allowed, true);
    if (decision.allowed) assert.deepEqual(decision.actor.operations, [operation]);
    for (const other of reportOperations.filter(candidate => candidate !== operation)) assert.equal((await withReports(operation).webUser(identity, other)).allowed, false);
  }
});

test('a report grant opens neither the claims inbox nor the audit lookup', async () => {
  const api = withReports(...reportOperations);
  for (const operation of ['claims:read', 'underwriting-decisions:read']) assert.equal((await api.webUser(identity, operation)).allowed, false);
});

test('report operations are web-only and fail closed on a missing session, an unavailable store or a bad lease', async () => {
  assert.deepEqual(await withReports(...reportOperations).mobileUser(identity, 'reports:read'), { allowed: false, error: 'forbidden', status: 403 });
  assert.equal((await withReports('reports:read').webUser({ ...identity, emailVerified: false }, 'reports:read')).status, 401);
  assert.equal((await new ApiAccess(partner, { ...sessions, find: async () => null }, undefined, undefined, undefined, undefined, grantedFor('reports:read')).webUser(identity, 'reports:read')).status, 401);
  const failing = { find: async () => { throw new Error('store down'); } };
  assert.deepEqual(await new ApiAccess(partner, sessions, undefined, undefined, undefined, undefined, failing).webUser(identity, 'reports:read'), { allowed: false, error: 'access_unavailable', status: 503 });
  const longLease = { find: async () => ({ expiresAt: new Date(Date.now() + 60_000).toISOString() }) };
  assert.equal((await new ApiAccess(partner, sessions, undefined, undefined, undefined, undefined, longLease).webUser(identity, 'reports:read')).status, 503);
  const expired = { find: async () => ({ expiresAt: new Date(Date.now() - 1).toISOString() }) };
  assert.equal((await new ApiAccess(partner, sessions, undefined, undefined, undefined, undefined, expired).webUser(identity, 'reports:read')).status, 503);
});

test('report grant inputs accept only the four report operations', () => {
  const input = { grantId: '90000000-0000-4000-8000-0000000000A1', clientId: '90000000-0000-4000-8000-0000000000B1', operation: 'reports:send',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), operatorReference: '90000000-0000-4000-8000-0000000000C1' };
  assert.equal(validateReportGrantInput('local', 'grant', input).operation, 'reports:send');
  for (const operation of ['claims:read', 'reports:other']) assert.throws(() => validateReportGrantInput('local', 'grant', { ...input, operation }));
});
