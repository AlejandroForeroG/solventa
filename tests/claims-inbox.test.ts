import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { ageDays, evidenceOf, InvalidClaimRecord, priorityOf, summarize, type OpenClaimRecord } from '../backend/policy-claims-payments/src/domain/claims';
import { ClaimInbox } from '../backend/policy-claims-payments/src/application/claim-inbox';
import { claimQuery } from '../backend/policy-claims-payments/src/adapters/inbound/claims-http';
import { createHttp } from '../backend/policy-claims-payments/src/adapters/inbound/http';
import worker from '../apps/web/worker/index';

const ids = { client: '90000000-0000-4000-8000-000000000001', claim: '90000000-0000-4000-8000-000000000010', policy: '90000000-0000-4000-8000-000000000020' };
const now = new Date('2026-11-05T15:00:00.000Z');
const record = (change: Partial<OpenClaimRecord> = {}): OpenClaimRecord => ({ id: ids.claim, claimNumber: 'SIN-2026-01187', policyId: ids.policy, state: 'in_review',
  openedAt: new Date('2026-10-27T15:00:00.000Z'), estimatedAmount: '148000000.0000', currency: 'COP', assigneeId: null, provided: 4, required: 5, unverified: 0, ...change });

test('age counts Bogotá calendar days, so a late-evening report is one day old after local midnight', () => {
  assert.equal(ageDays(new Date('2026-11-05T04:59:00.000Z'), new Date('2026-11-05T05:01:00.000Z')), 1);
  assert.equal(ageDays(new Date('2026-11-05T05:00:00.000Z'), new Date('2026-11-06T04:59:00.000Z')), 0);
  assert.equal(ageDays(new Date('2026-11-06T00:00:00.000Z'), now), 0);
});

test('priority follows age thresholds and escalation, never a caller-supplied value', () => {
  for (const [age, expected] of [[0, 'low'], [1, 'low'], [2, 'medium'], [4, 'medium'], [5, 'high'], [9, 'high']] as const) assert.equal(priorityOf('in_review', age), expected);
  assert.equal(priorityOf('escalated', 0), 'high');
  assert.equal(priorityOf('unassigned', 1), 'low');
});

test('evidence is incomplete until the required count, then in review until every item is verified', () => {
  assert.deepEqual(evidenceOf(2, 3, 0), { provided: 2, required: 3, status: 'incomplete' });
  assert.deepEqual(evidenceOf(3, 3, 1), { provided: 3, required: 3, status: 'in_review' });
  assert.deepEqual(evidenceOf(3, 3, 0), { provided: 3, required: 3, status: 'complete' });
  assert.deepEqual(evidenceOf(0, 0, 0), { provided: 0, required: 0, status: 'complete' });
});

test('a stored record that breaks the contract is rejected instead of being listed', () => {
  assert.equal(summarize(record(), now).priority, 'high');
  for (const change of [{ state: 'paid' as const }, { claimNumber: 'bad' }, { estimatedAmount: '148000000' }, { currency: 'cop' }, { provided: -1 }, { unverified: 5 },
    { claimNumber: null as unknown as string }, { estimatedAmount: '-1.0000' }]) assert.throws(() => summarize(record(change), now), InvalidClaimRecord);
});

test('a claim reported by the customer is listed with no estimate until an analyst sets one', () => {
  assert.equal(summarize(record({ estimatedAmount: null }), now).estimatedAmount, null);
});

test('an expired authorization cannot start or release a read', async () => {
  let reads = 0; let late = false;
  const inbox = new ClaimInbox({ list: async () => { reads++; late = true; return { records: [record()], next: null }; } }, { now: () => late ? new Date(now.getTime() + 10_000) : now });
  const reader = { clientId: ids.client, traceId: ids.claim, expiresAt: new Date(now.getTime() + 5000).toISOString() };
  await assert.rejects(inbox.list({}, { ...reader, expiresAt: now.toISOString() }), /expired/); assert.equal(reads, 0);
  await assert.rejects(inbox.list({}, reader), /expired/); assert.equal(reads, 1);
});

test('filters reject ambiguous, unbounded and malformed inputs', () => {
  for (const query of ['limit=100', 'state=archived', 'state=in_review&state=escalated', 'overdue=false', 'overdue=', 'query=SIN-1', 'query=', 'before=x', 'state=']) {
    assert.equal(claimQuery(new URLSearchParams(query)), null, query);
  }
  assert.deepEqual(claimQuery(new URLSearchParams('')), {});
  assert.deepEqual(claimQuery(new URLSearchParams(`state=escalated&overdue=true&query=SIN-2026-01187&before=${ids.claim.toUpperCase()}`)),
    { state: 'escalated', overdue: true, query: 'SIN-2026-01187', before: ids.claim });
  assert.deepEqual(claimQuery(new URLSearchParams(`query=${ids.policy.toUpperCase()}`)), { query: ids.policy });
});

const expiresIn = (ms: number) => new Date(Date.now() + ms).toISOString();
const granted = (change: Record<string, unknown> = {}) => ({ allowed: true, actor: { kind: 'user', channel: 'web', principal: { clientId: ids.client, subjectToken: ids.policy },
  operations: ['claims:read'], authorizationExpiresAt: expiresIn(5000), ...change } });
function http(access: unknown = granted(), fail = false) {
  let reads = 0; let authorization: Record<string, unknown> = {}; let reader: unknown;
  const inbox = new ClaimInbox({ list: async (_query, supplied) => { reads++; reader = supplied; if (fail) throw new Error('audit insert failed'); return { records: [record()], next: null }; } }, { now: () => new Date() });
  const app = createHttp({ authorizeFinancialAccess: async () => null, denyResourceAccess: async () => null, finance: {} as never,
    claims: { inbox, authorize: async input => { authorization = input; return access; } } });
  return { app, reads: () => reads, authorization: () => authorization, reader: () => reader };
}
const env = { APP_ENV: 'local' } as PolicyEnv;
const call = (service: ReturnType<typeof http>, path = '', init: RequestInit = {}) => service.app.request(`https://claims.example.invalid/api/v1/claims${path}`, { ...init, headers: { cookie: 'solventa-session=synthetic', ...init.headers } }, env);

test('HTTP authenticates before validating the query or reading data', async () => {
  for (const [status, error] of [[401, 'unauthorized'], [403, 'forbidden']] as const) {
    const service = http({ allowed: false, status, error });
    const response = await call(service, '?limit=1000');
    assert.equal(response.status, status); assert.deepEqual((await response.json()).error, error); assert.equal(service.reads(), 0);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.match(response.headers.get('x-trace-id') ?? '', /^[0-9a-f-]{36}$/);
  }
});

test('HTTP sends a fixed read operation, forwards the cookie and releases only the page', async () => {
  const service = http();
  const response = await call(service, `?state=in_review&before=${ids.claim}`);
  assert.equal(response.status, 200);
  assert.deepEqual(service.authorization(), { kind: 'web', operation: 'claims:read', traceId: response.headers.get('x-trace-id'), method: 'GET',
    requestOrigin: 'https://claims.example.invalid', origin: '', cookie: 'synthetic' });
  assert.deepEqual(service.reader(), { clientId: ids.client, traceId: response.headers.get('x-trace-id'), expiresAt: (service.reader() as { expiresAt: string }).expiresAt });
  const body = await response.json();
  assert.equal(body.items.length, 1); assert.equal(body.next, null); assert.equal(body.items[0].assigneeId, null);
});

test('HTTP rejects methods, bearer credentials and invalid queries without a read', async () => {
  const service = http();
  const method = await call(service, '', { method: 'POST' }); assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'GET');
  assert.equal((await call(service, '', { headers: { authorization: 'Bearer synthetic' } })).status, 400);
  assert.equal((await call(service, '?state=archived')).status, 400); assert.equal(service.reads(), 0);
});

test('HTTP rejects stale or malformed permission assertions and releases nothing after a storage or audit failure', async () => {
  const cases = [null, {}, { allowed: true, actor: { kind: 'partner' } }, granted({ channel: 'mobile' }), granted({ operations: ['underwriting-decisions:read'] }),
    granted({ authorizationExpiresAt: '2099-01-01T00:00:00.000Z' }), granted({ authorizationExpiresAt: new Date(Date.now() - 1000).toISOString() }),
    granted({ principal: { clientId: 'not-a-uuid', subjectToken: ids.policy } }), { allowed: false, status: 503, error: 'access_unavailable' }];
  for (const access of cases) {
    const service = http(access); const response = await call(service);
    assert.equal(response.status, 503, JSON.stringify(access)); assert.equal(service.reads(), 0);
  }
  const failing = http(undefined, true); const response = await call(failing);
  assert.equal(response.status, 503); assert.equal((await response.text()).includes('148000000'), false);
});

test('the gateway routes only the exact claims prefix to Policy and keeps version headers', async () => {
  const service = http();
  const environment = { APP_ENV: 'local', POLICY: { fetch: (request: Request) => service.app.request(request, undefined, env) } } as unknown as WebEnv;
  const ok = await worker.fetch(new Request('http://localhost:8787/api/v1/claims', { headers: { cookie: 'solventa-session=synthetic' } }), environment);
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal((await worker.fetch(new Request('http://localhost:8787/api/v1/claims-other'), environment)).status, 404);
  const down = await worker.fetch(new Request('http://localhost:8787/api/v1/claims'), { APP_ENV: 'local', POLICY: { fetch: async () => { throw new Error('down'); } } } as unknown as WebEnv);
  assert.equal(down.status, 503); assert.equal((await down.json()).error, 'service_unavailable');
});

test('actual responses and committed examples match the public OpenAPI schemas', async () => {
  const schema = parse(readFileSync('packages/contracts/openapi/v1/claims.yaml', 'utf8'));
  const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv);
  ajv.addSchema({ ...schema, $id: 'https://solventa.test/claims' });
  const check = (name: string, body: unknown) => {
    const validate = ajv.getSchema(`https://solventa.test/claims#/components/schemas/${name}`); assert.ok(validate);
    assert.equal(validate(body), true, JSON.stringify(validate.errors));
  };
  const examples = JSON.parse(readFileSync('packages/contracts/examples/claims.json', 'utf8'));
  check('ClaimPage', examples.page); check('ClaimPage', examples.emptyPage); check('Error', examples.invalidRequest); check('Error', examples.forbidden);
  const service = http();
  check('ClaimPage', await (await call(service)).json());
  check('Error', await (await call(http({ allowed: false, status: 403, error: 'forbidden' }))).json());
  check('Error', await (await call(service, '?state=archived')).json());
  check('Error', await (await call(service, '', { method: 'POST' })).json());
  for (const state of parse(readFileSync('packages/contracts/openapi/v1/claims.yaml', 'utf8')).components.schemas.ClaimState.enum) assert.ok(claimQuery(new URLSearchParams({ state })));
  assert.deepEqual(summarize(record({ state: 'escalated', openedAt: new Date('2026-11-05T10:00:00.000Z') }), now).priority, 'high');
  check('ClaimSummary', summarize(record(), now));
});
