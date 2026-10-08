import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { apiVersions } from '../packages/contracts/src/versions';
import type { ApiVersion } from '../packages/contracts/src/versions';
import { gateApiVersion } from '../apps/web/worker/api-versions';
import worker from '../apps/web/worker/index';

const retiring: ApiVersion[] = [{ id: 'v1', deprecatedAt: '2026-10-01', sunset: '2027-06-06' }, { id: 'v2' }];
const sunsetInstant = Date.parse('2027-06-06T05:00:00Z');
const methods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value: string) => dayPattern.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

function registryViolations(versions: readonly ApiVersion[]): string[] {
  const problems: string[] = [];
  const numbers = versions.map(v => Number(v.id.slice(1)));
  versions.forEach(v => {
    if (!/^v[1-9][0-9]*$/.test(v.id)) problems.push(`${v.id}: invalid id`);
    if (v.sunset && !isDay(v.sunset)) problems.push(`${v.id}: invalid sunset`);
    if (v.deprecatedAt && !isDay(v.deprecatedAt)) problems.push(`${v.id}: invalid deprecatedAt`);
    if (v.sunset && !v.deprecatedAt) problems.push(`${v.id}: sunset without deprecatedAt`);
    if (v.sunset && v.deprecatedAt && v.deprecatedAt >= v.sunset) problems.push(`${v.id}: sunset must follow deprecatedAt`);
  });
  if (numbers.some((n, i) => i > 0 && n <= numbers[i - 1])) problems.push('ids must be unique and ascending');
  return problems;
}

// `location` is relative to the openapi folder: <version>/<domain>.yaml
function specViolations(spec: any, location: string, versions: readonly ApiVersion[]): string[] {
  const problems: string[] = [];
  const [id, file, ...deeper] = location.split('/');
  if (!file || deeper.length) return [`${location}: specs must sit directly inside a version folder`];
  const entry = versions.find(v => v.id === id);
  if (!entry) return [`${location}: version not in registry`];
  if (!String(spec.info?.version).startsWith(`${id.slice(1)}.`)) problems.push(`${location}: info.version must start with ${id.slice(1)}.`);
  if (spec.servers?.[0]?.url !== `/api/${id}`) problems.push(`${location}: first server must be /api/${id}`);
  if (spec.info?.['x-sunset'] !== entry.sunset) problems.push(`${location}: info.x-sunset must match the registry`);
  for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
    for (const method of methods.filter(m => item[m])) {
      if (Boolean(item[method].deprecated) !== Boolean(entry.sunset)) problems.push(`${location}: ${method} ${path} deprecated flag must match the registry`);
    }
  }
  return problems;
}

test('a version with a future sunset still answers and announces its retirement', () => {
  const gate = gateApiVersion('/api/v1/quotes', new Date(sunsetInstant - 1), retiring);
  assert.equal(gate.response, undefined);
  assert.deepEqual(gate.headers, {
    Deprecation: '@1790830800',
    Sunset: 'Sun, 06 Jun 2027 05:00:00 GMT',
    Link: '</api/v2/quotes>; rel="successor-version"',
  });
});

test('a version is retired from its sunset day and points to its successor', async () => {
  const gate = gateApiVersion('/api/v1/quotes', new Date(sunsetInstant), retiring);
  assert.equal(gate.response?.status, 410);
  assert.deepEqual(await gate.response?.json(), { error: 'version_retired' });
  assert.equal(gate.response?.headers.get('link'), '</api/v2/quotes>; rel="successor-version"');
});

test('v1 and v2 coexist: the newer version never carries deprecation headers', () => {
  for (const instant of [Date.parse('2026-10-02T00:00:00Z'), sunsetInstant - 1, sunsetInstant, Date.parse('2040-01-01T00:00:00Z')]) {
    const gate = gateApiVersion('/api/v2/quotes', new Date(instant), retiring);
    assert.equal(gate.response, undefined);
    assert.deepEqual(gate.headers, {});
  }
});

test('a version without sunset is never retired and carries no headers', () => {
  for (const instant of [0, Date.parse('2026-10-06T00:00:00Z'), Date.parse('2100-01-01T00:00:00Z')]) {
    const gate = gateApiVersion('/api/v1', new Date(instant), [{ id: 'v1' }]);
    assert.equal(gate.response, undefined);
    assert.deepEqual(gate.headers, {});
  }
});

test('retiring the last version omits the successor link', () => {
  const gate = gateApiVersion('/api/v1/quotes', new Date(sunsetInstant - 1), [retiring[0]]);
  assert.equal(gate.headers.Link, undefined);
  assert.ok(gate.headers.Sunset);
});

test('paths outside a registered version are ignored', () => {
  for (const path of ['/api/quotes', '/api/v1x/quotes', '/api/v9/quotes', '/api/v10/quotes', '/health', '/auth/session']) {
    const gate = gateApiVersion(path, new Date(sunsetInstant), retiring);
    assert.equal(gate.response, undefined, path);
    assert.deepEqual(gate.headers, {}, path);
  }
});

test('the web Worker keeps answering 404 for an unimplemented version without deprecation headers', async () => {
  const response = await worker.fetch(new Request('https://solventa.invalid/api/v1/quotes'), { APP_ENV: 'local' } as WebEnv);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_implemented' });
  assert.equal(response.headers.get('deprecation'), null);
  assert.equal(response.headers.get('sunset'), null);
});

test('access gateway failures preserve valid trace IDs and replace invalid ones', async () => {
  const validTrace = '50000000-0000-4000-8000-000000000001';
  for (const trace of [validTrace, 'invalid']) {
    const response = await worker.fetch(new Request('https://solventa.invalid/api/v1/access/web', { headers: { 'X-Trace-Id': trace } }), {
      IDENTITY: { fetch: async () => { throw new Error('unavailable'); } },
    } as WebEnv);
    const body = await response.json() as { error: string; traceId: string };
    assert.equal(response.status, 503);
    assert.equal(body.error, 'access_unavailable');
    assert.equal(response.headers.get('x-trace-id'), body.traceId);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (trace === validTrace) assert.equal(body.traceId, trace);
    else assert.match(body.traceId, /^[0-9a-f-]{36}$/);
  }
});

test('the access gateway aborts stalled Identity calls after five seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let upstreamSignal: AbortSignal | undefined;
  const result = worker.fetch(new Request('https://solventa.invalid/api/v1/access/partner'), {
    IDENTITY: { fetch: (request: Request) => new Promise<Response>((_resolve, reject) => {
      upstreamSignal = request.signal;
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    }) },
  } as WebEnv);
  t.mock.timers.tick(4999);
  assert.equal(upstreamSignal?.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(upstreamSignal?.aborted, true);
  const response = await result;
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { error: string }).error, 'access_unavailable');
});

test('the version registry is well formed', () => {
  assert.deepEqual(registryViolations(apiVersions), []);
});

test('the registry validator rejects malformed entries', () => {
  assert.ok(registryViolations([{ id: 'v0' }]).length);
  assert.ok(registryViolations([{ id: 'v1', sunset: '2027-06-06' }]).length);
  assert.ok(registryViolations([{ id: 'v1', deprecatedAt: '2027-06-06', sunset: '2027-06-06' }]).length);
  assert.ok(registryViolations([{ id: 'v1', deprecatedAt: '2026-13-01', sunset: '2027-06-06' }]).length);
  assert.ok(registryViolations([{ id: 'v2' }, { id: 'v1' }]).length);
});

test('every OpenAPI spec matches its registry entry and every version has a spec', () => {
  const directory = 'packages/contracts/openapi';
  const locations = (readdirSync(directory, { recursive: true }) as string[]).map(name => name.split('\\').join('/')).filter(name => name.endsWith('.yaml'));
  assert.ok(locations.length);
  for (const location of locations) assert.deepEqual(specViolations(parse(readFileSync(`${directory}/${location}`, 'utf8')), location, apiVersions), []);
  for (const version of apiVersions) assert.ok(locations.some(location => location.startsWith(`${version.id}/`)), `${version.id} has no spec`);
});

test('the spec validator rejects specs that contradict the registry', () => {
  const base = { info: { version: '1.0.0' }, servers: [{ url: '/api/v1' }], paths: { '/quotes': { post: {} } } };
  assert.deepEqual(specViolations(base, 'v1/quotes.yaml', [{ id: 'v1' }]), []);
  assert.ok(specViolations(base, 'v1/quotes.yaml', [retiring[0]]).length, 'sunset without x-sunset or deprecated flag');
  assert.ok(specViolations({ ...base, paths: { '/quotes': { post: { deprecated: true } } } }, 'v1/quotes.yaml', [{ id: 'v1' }]).length, 'deprecated without sunset');
  assert.ok(specViolations({ ...base, servers: [{ url: '/v1' }] }, 'v1/quotes.yaml', [{ id: 'v1' }]).length);
  assert.ok(specViolations({ ...base, info: { version: '2.0.0' } }, 'v1/quotes.yaml', [{ id: 'v1' }]).length);
  assert.ok(specViolations(base, 'v3/quotes.yaml', [{ id: 'v1' }]).length, 'version not in registry');
  assert.ok(specViolations(base, 'quotes.yaml', [{ id: 'v1' }]).length, 'spec outside a version folder');
  assert.ok(specViolations(base, 'v1/nested/quotes.yaml', [{ id: 'v1' }]).length, 'spec nested deeper than the version folder');
});

test('a retiring version requires the sunset on every domain spec of that version', () => {
  const dated = { info: { version: '1.0.0', 'x-sunset': '2027-06-06' }, servers: [{ url: '/api/v1' }], paths: {} };
  assert.deepEqual(specViolations(dated, 'v1/quotes.yaml', [retiring[0]]), []);
  assert.ok(specViolations({ ...dated, info: { version: '1.0.0' } }, 'v1/consents.yaml', [retiring[0]]).length);
});
