import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createHttp } from '../backend/policy-claims-payments/src/adapters/inbound/http';
import { reportQuery, type ReportOperationName } from '../backend/policy-claims-payments/src/adapters/inbound/reports-http';
import { Reports } from '../backend/policy-claims-payments/src/application/reports';
import { currentPeriod } from '../backend/policy-claims-payments/src/domain/report';
import { Sha256ReportDigest } from '../backend/policy-claims-payments/src/adapters/outbound/sha256-report-digest';
import { TimerDeadline } from '../backend/policy-claims-payments/src/adapters/outbound/timer-deadline';
import worker from '../apps/web/worker/index';
import { ids, syntheticFacts } from './support/report-fixtures';
import { MemoryDestination, MemoryReportStore } from './support/report-fakes';

const period = currentPeriod(new Date());
const expiresIn = (ms: number) => new Date(Date.now() + ms).toISOString();
const granted = (operation: ReportOperationName, change: Record<string, unknown> = {}) => ({ allowed: true, actor: { kind: 'user', channel: 'web', principal: { clientId: ids.operator, subjectToken: ids.policy(1) },
  operations: [operation], authorizationExpiresAt: expiresIn(5000), ...change } });
const env = { APP_ENV: 'local' } as PolicyEnv;

// `grants` decides, per operation, what Identity answers; an operation without a grant is the 403 a session alone gets.
function http(grants: Partial<Record<ReportOperationName, unknown>> = {}, options: { failStore?: boolean } = {}) {
  const store = new MemoryReportStore(syntheticFacts());
  const destinations = { regulator: new MemoryDestination('regulator'), reinsurer: new MemoryDestination('reinsurer') };
  if (options.failStore) store.facts = async () => { throw new Error('sql down'); };
  const authorizations: Record<string, unknown>[] = [];
  const reports = new Reports(store, new Sha256ReportDigest(), destinations, { now: () => new Date() }, new TimerDeadline(), 25);
  const app = createHttp({ authorizeFinancialAccess: async () => null, denyResourceAccess: async () => null, finance: {} as never,
    reports: { reports, authorize: async input => { authorizations.push(input); return Object.hasOwn(grants, input.operation) ? grants[input.operation] : { allowed: false, status: 403, error: 'forbidden' }; } } });
  return { app, store, destinations, authorizations };
}
const all = () => ({ 'reports:generate': granted('reports:generate'), 'reports:read': granted('reports:read'), 'reports:download': granted('reports:download'), 'reports:send': granted('reports:send') });
const call = (service: ReturnType<typeof http>, path: string, init: RequestInit = {}) => service.app.request(`https://reports.example.invalid/api/v1/reports${path}`,
  { ...init, headers: { cookie: 'solventa-session=synthetic', origin: 'https://reports.example.invalid', ...(init.method === 'POST' ? { 'content-type': 'application/json' } : {}), ...init.headers } }, env);
const generate = (service: ReturnType<typeof http>, body: unknown = { period, destination: 'regulator', format: 'csv' }) => call(service, '', { method: 'POST', body: JSON.stringify(body) });

test('a valid session without the exact grant is denied every report operation and nothing is read, stored or audited', async () => {
  const service = http();
  const responses = [await call(service, ''), await generate(service), await call(service, `/${ids.claim(1)}/download`), await call(service, `/${ids.claim(1)}/delivery`, { method: 'POST', body: '{}' })];
  for (const response of responses) { assert.equal(response.status, 403); assert.equal((await response.json()).error, 'forbidden'); assert.equal(response.headers.get('cache-control'), 'no-store'); }
  assert.deepEqual(service.authorizations.map(input => input.operation), ['reports:read', 'reports:generate', 'reports:download', 'reports:send']);
  assert.equal(service.store.revisions.length, 0); assert.equal(service.store.audit.length, 0);
});

test('one grant opens one operation: reading never lets a caller generate, download or send', async () => {
  const service = http({ 'reports:read': granted('reports:read') });
  assert.equal((await call(service, '')).status, 200);
  assert.equal((await generate(service)).status, 403);
  assert.equal(service.store.revisions.length, 0);
  const owner = http(all());
  const created = await (await generate(owner)).json();
  const swapped = http({ 'reports:download': granted('reports:read') });
  assert.equal((await call(swapped, `/${created.report.reportId}/download`)).status, 503);
});

test('unauthenticated, bearer and mixed credentials are refused before any read', async () => {
  const service = http({ 'reports:read': { allowed: false, status: 401, error: 'unauthorized' } });
  const unauthorized = await call(service, ''); assert.equal(unauthorized.status, 401);
  assert.equal((await call(http(all()), '', { headers: { authorization: 'Bearer synthetic' } })).status, 400);
  assert.equal((await call(http(all()), '', { method: 'PUT' })).status, 405);
  assert.equal((await call(http(all()), `/${ids.claim(1)}/download`, { method: 'POST', body: '{}' })).headers.get('allow'), 'GET');
  assert.equal((await call(http(all()), `/${ids.claim(1)}/delivery`)).headers.get('allow'), 'POST');
});

test('generate forwards the exact operation, cookie and origin, and the input never carries data', async () => {
  const service = http(all());
  const response = await generate(service);
  assert.equal(response.status, 201);
  assert.deepEqual(service.authorizations[0], { kind: 'web', operation: 'reports:generate', traceId: response.headers.get('x-trace-id'), method: 'POST',
    requestOrigin: 'https://reports.example.invalid', origin: 'https://reports.example.invalid', cookie: 'synthetic' });
  const body = await response.json();
  assert.equal(body.created, true); assert.equal(body.report.revision, 1); assert.equal(body.report.delivery, undefined);
  assert.equal((await generate(service)).status, 200);
  for (const bad of [{ period, destination: 'regulator' }, { period, destination: 'regulator', format: 'xlsx' }, { period, destination: 'auditor', format: 'csv' }, { period: '2026-13', destination: 'regulator', format: 'csv' },
    { period, destination: 'regulator', format: 'csv', totals: [] }, { period, destination: 'regulator', format: 'csv', rows: [] }, []]) assert.equal((await generate(service, bad)).status, 400, JSON.stringify(bad));
  assert.equal((await call(service, '', { method: 'POST', body: '{', headers: {} })).status, 400);
  assert.equal((await call(service, '', { method: 'POST', body: JSON.stringify({ period, destination: 'regulator', format: 'csv' }), headers: { 'content-type': 'text/plain' } })).status, 415);
  const future = await generate(service, { period: `${Number(period.slice(0, 4)) + 1}-01`, destination: 'regulator', format: 'csv' });
  assert.equal(future.status, 400); assert.deepEqual((await future.json()).fields, ['period']);
  assert.equal(service.store.revisions.length, 1);
});

test('download releases the artifact as an attachment with its hash and audits it', async () => {
  const service = http(all());
  const { report } = await (await generate(service, { period, destination: 'reinsurer', format: 'csv' })).json();
  const csv = await call(service, `/${report.reportId}/download`);
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type') ?? '', /^text\/csv/); assert.equal(csv.headers.get('x-report-hash'), report.contentHash);
  assert.match(csv.headers.get('content-disposition') ?? '', /^attachment; filename="reinsurer-.*-r1\.csv"$/);
  assert.match(await csv.text(), /^record_type,policy_id,claim_id,/);
  const manifest = await call(service, `/${report.reportId}/download?file=manifest`);
  assert.equal(JSON.parse(await manifest.text()).contentHash, report.contentHash);
  assert.equal((await call(service, `/${ids.claim(9)}/download`)).status, 404);
  for (const bad of [`/not-a-uuid/download`, `/${report.reportId}/download?file=pdf`, `/${report.reportId}/download?file=csv&file=manifest`, `/${report.reportId}/download?x=1`]) assert.equal((await call(service, bad)).status, 400, bad);
  service.store.revisions[0].content += 'tampered\n';
  const tampered = await call(service, `/${report.reportId}/download`);
  assert.equal(tampered.status, 409); assert.equal((await tampered.json()).error, 'integrity_violation');
});

test('send answers 200 with the state, shows uncertain as such and never repeats a confirmed delivery', async () => {
  const service = http(all());
  service.destinations.regulator.silent = true;
  const { report } = await (await generate(service)).json();
  const post = () => call(service, `/${report.reportId}/delivery`, { method: 'POST', body: '{}' });
  const first = await (await post()).json();
  assert.equal(first.delivery.status, 'uncertain'); assert.equal(first.delivery.reference, null);
  const listed = await (await call(service, '')).json();
  assert.equal(listed.items[0].delivery.status, 'uncertain');
  const second = await (await post()).json();
  assert.equal(second.delivery.status, 'acknowledged'); assert.equal((await (await post()).json()).delivery.id, second.delivery.id); assert.equal(service.destinations.regulator.deliveries, 1);
  assert.equal((await call(service, `/${ids.claim(9)}/delivery`, { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await call(service, `/${report.reportId}/delivery`, { method: 'POST', body: '{"x":1}' })).status, 400);
  assert.equal((await call(service, `/${report.reportId}/delivery`, { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
});

test('stale or malformed permission assertions and storage failures release nothing', async () => {
  const cases = [null, {}, { allowed: true, actor: { kind: 'partner' } }, granted('reports:read', { channel: 'mobile' }), granted('reports:read', { operations: ['claims:read'] }),
    granted('reports:read', { operations: ['reports:read', 'reports:send'] }), granted('reports:read', { authorizationExpiresAt: '2099-01-01T00:00:00.000Z' }),
    granted('reports:read', { authorizationExpiresAt: new Date(Date.now() - 1000).toISOString() }), granted('reports:read', { principal: { clientId: 'x', subjectToken: ids.policy(1) } }),
    { allowed: false, status: 503, error: 'access_unavailable' }];
  for (const access of cases) {
    const service = http({ 'reports:read': access });
    assert.equal((await call(service, '')).status, 503, JSON.stringify(access)); assert.equal(service.store.audit.length, 0);
  }
  const failing = http(all(), { failStore: true });
  const response = await generate(failing);
  assert.equal(response.status, 503); assert.equal((await response.text()).includes('sql down'), false);
});

test('filters reject ambiguous and malformed input', () => {
  for (const query of ['limit=5', 'period=2026-13', 'period=2026-11&period=2026-10', 'destination=auditor', 'before=x', 'period=', 'format=csv']) assert.equal(reportQuery(new URLSearchParams(query)), null, query);
  assert.deepEqual(reportQuery(new URLSearchParams(`period=2026-11&destination=reinsurer&before=${ids.claim(1).toUpperCase()}`)), { period: '2026-11', destination: 'reinsurer', before: ids.claim(1) });
});

test('the gateway forwards only the exact reports prefix to Policy', async () => {
  const service = http(all());
  const environment = { APP_ENV: 'local', POLICY: { fetch: (request: Request) => service.app.request(request, undefined, env) } } as unknown as WebEnv;
  const ok = await worker.fetch(new Request('http://localhost:8787/api/v1/reports', { headers: { cookie: 'solventa-session=synthetic' } }), environment);
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal((await worker.fetch(new Request('http://localhost:8787/api/v1/reports-other'), environment)).status, 404);
  const large = await worker.fetch(new Request('http://localhost:8787/api/v1/reports', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'solventa-session=synthetic' }, body: 'x'.repeat(2048) }), environment);
  assert.notEqual(large.status, 200);
  const down = await worker.fetch(new Request('http://localhost:8787/api/v1/reports'), { APP_ENV: 'local', POLICY: { fetch: async () => { throw new Error('down'); } } } as unknown as WebEnv);
  assert.equal(down.status, 503);
});

test('actual responses and committed examples match the public OpenAPI schemas', async () => {
  const spec = parse(readFileSync('packages/contracts/openapi/v1/reports.yaml', 'utf8'));
  const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv);
  ajv.addSchema({ ...spec, $id: 'https://solventa.test/reports' });
  const check = (name: string, body: unknown) => {
    const validate = ajv.getSchema(`https://solventa.test/reports#/components/schemas/${name}`); assert.ok(validate, name);
    assert.equal(validate(body), true, JSON.stringify(validate.errors));
  };
  const examples = JSON.parse(readFileSync('packages/contracts/examples/reports.json', 'utf8'));
  check('ReportPage', examples.page); check('ReportPage', examples.emptyPage); check('GenerateResponse', examples.generated);
  check('SendResponse', examples.uncertainDelivery); check('SendResponse', examples.rejectedDelivery); check('Error', examples.invalidRequest); check('Error', examples.forbidden);
  const service = http(all());
  const created = await (await generate(service)).json();
  check('GenerateResponse', created);
  check('ReportPage', await (await call(service, '')).json());
  check('SendResponse', await (await call(service, `/${created.report.reportId}/delivery`, { method: 'POST', body: '{}' })).json());
  check('Manifest', await (await call(service, `/${created.report.reportId}/download?file=manifest`)).json());
  check('Error', await (await call(http(), '')).json());
  check('Error', await (await generate(service, {})).json());
  check('Error', await (await call(service, '', { method: 'PUT' })).json());
});
