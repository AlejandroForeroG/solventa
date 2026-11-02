import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { ApiAccess } from '../backend/identity-consent-ecosystem/src/application/api-access';
import { authorizeApiAccess } from '../backend/identity-consent-ecosystem/src/adapters/inbound/api-access-http';
import { AuditDecisions } from '../backend/acquisition-risk/src/application/audit-decisions';
import { explainDecision } from '../backend/acquisition-risk/src/domain/audit-decision';
import { auditQuery, mountAuditDecisions } from '../backend/acquisition-risk/src/adapters/inbound/audit-decisions-http';
import { auditIds, historicalMortgage } from './support/audit-fixtures';
import worker from '../apps/web/worker/index';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { validateAuditGrantInput } from '../infra/underwriting-audit-access.mjs';

const identity = { providerSubject: 'synthetic-auditor', sessionReference: 'synthetic-session', emailVerified: true };
const principal = { clientId: auditIds.client, subjectToken: auditIds.subject };
const sessions = { find: async () => principal, open: async () => principal, revoke: async () => {} };
const partner = { find: async () => null };
const operation = 'underwriting-decisions:read';
test('a session alone never grants audit access; partner and native channels remain denied even with a grant', async () => {
  const api = new ApiAccess(partner, sessions);
  assert.deepEqual(await api.webUser(identity, operation), { allowed: false, error: 'forbidden', status: 403 });
  let lookups = 0;
  const authorized = new ApiAccess(partner, sessions, { find: async () => { lookups++; return { expiresAt: new Date(Date.now() + 5000).toISOString() }; } });
  assert.equal((await authorized.webUser(identity, operation)).allowed, true);
  assert.equal((await authorized.mobileUser(identity, operation)).allowed, false);
  assert.equal((await authorized.partner({ issuer: 'https://synthetic.invalid', organizationId: 'org', applicationId: 'app', scopes: [operation] }, operation)).allowed, false);
  assert.equal(lookups, 1);
  assert.equal((await new ApiAccess(partner, { ...sessions, find: async () => null }, { find: async () => { assert.fail('grant before session'); } }).webUser(identity, operation)).status, 401);
});
test('revoked grants and unavailable permission storage fail closed and denial audit is required', async () => {
  for (const lookup of [async () => null, async () => { throw new Error('SQL unavailable'); }]) {
    const result = await new ApiAccess(partner, sessions, { find: lookup }).webUser(identity, operation);
    assert.equal(result.allowed, false);
  }
  const input = { kind: 'web', cookie: 'synthetic', operation, method: 'GET', origin: '', requestOrigin: 'https://audit.example.invalid' };
  const result = await authorizeApiAccess({ application: new ApiAccess(partner, sessions), partner: null,
    web: { allowedOrigins: [input.requestOrigin], authenticate: async () => ({ identity }) }, security: { deny: async () => { throw new Error('audit unavailable'); } } }, input);
  assert.deepEqual(result, { allowed: false, error: 'access_unavailable', status: 503 });
});
test('historical accepted and declined decisions explain retained facts and never consult current providers or consent', () => {
  for (const declined of [false, true]) {
    const detail = explainDecision(historicalMortgage(declined));
    assert.equal(detail.reconstruction.status, 'reconstructed');
    assert.equal(detail.reconstruction.checks?.paymentScoreSufficient, !declined);
    assert.equal(detail.model.status, 'not_used');
    assert.equal(detail.sources.length, 4);
    assert.equal(detail.consent?.id, 'CNS-2026-00001');
    assert.equal(detail.inputs.monthlyIncomeCop, 8000000);
  }
});
test('legacy gaps, unknown artifacts and disagreement with immutable row/revisions are explicit', () => {
  const record = historicalMortgage();
  const snapshot = JSON.parse(JSON.stringify(record.snapshot));
  delete snapshot.inputs.identityVerified;
  const detail = explainDecision({ ...record, snapshot });
  assert.equal(detail.reconstruction.status, 'incomplete_capture');
  assert.deepEqual(detail.reconstruction.missing, ['inputs.identityVerified']);
  assert.equal('identityVerified' in detail.inputs, false);
  for (const change of [{ outcome: 'declined' }, { correlationId: auditIds.client }, { revisions: [{ ...record.revisions[0], premium: '1.0000' }] }]) {
    assert.equal(explainDecision({ ...record, ...change }).reconstruction.status, 'inconsistent_capture');
  }
  snapshot.rule.version = 'future-1'; snapshot.privateToken = 'must-not-leak'; snapshot.inputs.privateToken = 'must-not-leak';
  assert.equal(explainDecision({ ...record, snapshot }).reconstruction.status, 'unsupported_rule');
  assert.equal(JSON.stringify(explainDecision({ ...record, snapshot })).includes('must-not-leak'), false);
});
test('an expired authorization cannot start or release a lookup', async () => {
  const now = new Date(); let expired = false; let read = 0;
  const audit = new AuditDecisions({ list: async () => { read++; expired = true; return { items: [], next: null }; }, get: async () => null }, { now: () => expired ? new Date(now.getTime() + 10000) : now });
  const reader = { clientId: auditIds.client, traceId: auditIds.trace, expiresAt: new Date(now.getTime() + 5000).toISOString() };
  await assert.rejects(audit.list({}, { ...reader, expiresAt: now.toISOString() }), /expired/); assert.equal(read, 0);
  await assert.rejects(audit.list({}, reader), /expired/); assert.equal(read, 1);
});
test('filters reject ambiguous, unbounded and invalid calendar inputs', () => {
  for (const query of ['limit=10000', 'reference=x', 'from=2026-02-30', 'from=2026-11-02&to=2026-11-01', 'outcome=accepted&outcome=declined', 'product=other', 'before=x', 'to=']) assert.equal(auditQuery(new URLSearchParams(query)), null, query);
  assert.deepEqual(auditQuery(new URLSearchParams('product=flight_delay&from=2026-10-01&to=2026-11-01')), { product: 'flight_delay', from: '2026-10-01', to: '2026-11-01' });
});
function http(access: unknown = { allowed: true, actor: { kind: 'user', channel: 'web', principal, operations: [operation], authorizationExpiresAt: new Date(Date.now() + 5000).toISOString() } }, fail = false) {
  const app = new Hono<{ Bindings: AcquisitionEnv }>(); let reads = 0; let authorization: unknown;
  mountAuditDecisions(app, { authorize: async input => { authorization = input; return access; }, decisions: new AuditDecisions({
    list: async () => { reads++; if (fail) throw new Error('audit insert failed'); return { items: [historicalMortgage()], next: null }; },
    get: async id => { reads++; if (fail) throw new Error('audit insert failed'); return id === auditIds.decision ? historicalMortgage() : null; }
  }, { now: () => new Date() }) });
  return { app, reads: () => reads, authorization: () => authorization };
}
test('HTTP authenticates before looking up or validating protected resource identifiers', async () => {
  for (const status of [401, 403]) {
    const service = http({ allowed: false, status, error: status === 401 ? 'unauthorized' : 'forbidden' });
    const response = await service.app.request('https://audit.example.invalid/api/v1/underwriting-decisions/not-a-uuid', {}, { APP_ENV: 'local' } as AcquisitionEnv);
    assert.equal(response.status, status); assert.equal(service.reads(), 0); assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});
test('HTTP rejects stale/malformed permission assertions and never releases data after storage/audit failure', async () => {
  for (const access of [null, {}, { allowed: true, actor: { kind: 'partner' } }, { allowed: true, actor: { kind: 'user', channel: 'web', principal, operations: [operation], authorizationExpiresAt: '2099-01-01T00:00:00Z' } }]) {
    const service = http(access); assert.equal((await service.app.request('https://audit.example.invalid/api/v1/underwriting-decisions', {}, { APP_ENV: 'local' } as AcquisitionEnv)).status, 503); assert.equal(service.reads(), 0);
  }
  const service = http(undefined, true); const response = await service.app.request(`https://audit.example.invalid/api/v1/underwriting-decisions/${auditIds.decision}`, {}, { APP_ENV: 'local' } as AcquisitionEnv);
  assert.equal(response.status, 503); assert.equal((await response.text()).includes('monthlyIncome'), false);
});
test('gateway routes the real audit handler, preserves version headers and returns detailed or absent records', async () => {
  const service = http();
  const env = { APP_ENV: 'local', ACQUISITION: { fetch: (request: Request) => service.app.request(request, undefined, { APP_ENV: 'local' } as AcquisitionEnv) } } as unknown as WebEnv;
  for (const [id, status] of [[auditIds.decision, 200], [auditIds.client, 404], ['invalid', 400]] as const) {
    const response = await worker.fetch(new Request(`http://localhost:8787/api/v1/underwriting-decisions/${id}`, { headers: { cookie: 'solventa-session=synthetic' } }), env);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (status === 200) { const body = await response.json(); assert.equal(body.decision.reconstruction.status, 'reconstructed'); assert.equal(body.decision.snapshot, undefined); }
  }
  const method = await service.app.request('http://localhost:8787/api/v1/underwriting-decisions', { method: 'POST' }, { APP_ENV: 'local' } as AcquisitionEnv);
  assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'GET');
  assert.equal((service.authorization() as { cookie: string }).cookie, 'synthetic');
});

test('actual list, detail and error responses and committed examples match the public OpenAPI schemas', async () => {
  const schema = parse(readFileSync('packages/contracts/openapi/v1/underwriting-decisions.yaml', 'utf8'));
  const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv);
  ajv.addSchema({ ...schema, $id: 'https://solventa.test/audit' });
  const check = (name: string, body: unknown) => {
    const validate = ajv.getSchema(`https://solventa.test/audit#/components/schemas/${name}`); assert.ok(validate);
    assert.equal(validate(body), true, JSON.stringify(validate.errors));
  };
  const examples = JSON.parse(readFileSync('packages/contracts/examples/underwriting-audit.json', 'utf8'));
  check('Page', examples.page); check('Detail', examples.detail);
  for (const [path, expected] of [['', 'Page'], ['/' + auditIds.decision, 'Detail'], ['/' + auditIds.client, 'Error'], ['?limit=999', 'Error']]) {
    const response = await http().app.request('http://localhost:8787/api/v1/underwriting-decisions' + path, {}, { APP_ENV: 'local' } as AcquisitionEnv);
    check(expected, await response.json());
  }
});

test('the retained flight artifact identifies mocked sources and its fixed historical price without inventing a model', () => {
  const record = historicalMortgage();
  const snapshot = { schemaVersion: 1, contractVersion: 'v1', correlationId: record.correlationId, inputs: { flightReference: auditIds.offer, scheduleAvailable: true, premium: '10000.0000', payoutAmount: '100000.0000', thresholdMinutes: 180 },
    sources: [{ source: 'mock:flight-schedule', capturedAt: record.decidedAt, quality: 'mock', degraded: false }], consent: { status: 'not_required' }, rule: { id: 'flight-underwriting', version: 'academic-flight-1' }, outcome: 'accepted' };
  const flight = { ...record, quoteId: null, product: 'flight_delay', ruleVersion: 'academic-flight-1', snapshot, revisions: [] };
  assert.equal(explainDecision(flight).reconstruction.status, 'reconstructed');
  assert.equal(explainDecision(flight).model.status, 'not_used');
  const { flightReference: _flight, scheduleAvailable: _available, ...legacyInputs } = snapshot.inputs;
  assert.deepEqual(explainDecision({ ...flight, snapshot: { ...snapshot, inputs: legacyInputs } }).reconstruction, { status: 'incomplete_capture', missing: ['inputs.flightReference', 'inputs.scheduleAvailable'] });
  assert.equal(explainDecision({ ...flight, snapshot: { ...snapshot, inputs: { ...snapshot.inputs, premium: '1.0000' } } }).reconstruction.status, 'inconsistent_capture');
  assert.equal(explainDecision({ ...flight, snapshot: { ...snapshot, sources: [] } }).reconstruction.status, 'invalid_capture');
});

test('grant administration rejects indefinite, excessive, malformed and ambiguous permissions', () => {
  const grant = { grantId: auditIds.decision, clientId: auditIds.client, operatorReference: auditIds.trace, expiresAt: new Date(Date.now() + 100000).toISOString() };
  assert.deepEqual(validateAuditGrantInput('local', 'grant', grant), grant);
  for (const change of [{ expiresAt: '2099-01-01T00:00:00.000Z' }, { expiresAt: new Date(Date.now() - 10000).toISOString() }, { expiresAt: '2026-02-30T10:00:00.000Z' }, { clientId: 'x' }, { operatorReference: 'root' }, { scopes: ['*'] }]) assert.throws(() => validateAuditGrantInput('local', 'grant', { ...grant, ...change }));
  assert.throws(() => validateAuditGrantInput('other', 'grant', grant));
  assert.throws(() => validateAuditGrantInput('local', 'revoke', grant));
});
