import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runtimeCoveragePlugins, captureRuntimeCoverage } from './support/runtime-coverage.mjs';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { build } = wranglerRequire('esbuild');
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const traceId = '50000000-0000-4000-8000-000000000001';

// The actual entrypoints, HTTP adapters, Service Bindings and Queue runtime execute.
// SQL transport and Policy application results are explicit collaborators here;
// the separate real SQL suites establish transaction and business invariants.
const stateScript = `
import { WorkerEntrypoint } from 'cloudflare:workers';
let settings = {}, queries = [], access = [], finance = [], probes = [];
export default class extends WorkerEntrypoint {
  async fetch(request) {
    if (new URL(request.url).pathname === '/configure') {
      settings = await request.json(); queries = []; access = []; finance = []; probes = [];
    }
    return Response.json({ queries, access, finance, probes });
  }
  liveness() { return { service: 'identity-consent-ecosystem', environment: settings.identityEnvironment ?? 'local' }; }
  probe(connection) { probes.push(connection); return { ready: true, databaseName: settings.database ?? 'solventa_local', code: 'ok' }; }
  async query(sql) {
    queries.push(sql);
    if (settings.failQuery) throw Error('synthetic_sql_failure');
    return { rows: sql.includes('age_ms') ? [{ age_ms: null }] : [], rowCount: 0 };
  }
  authorizeFinancialAccessV1(input) {
    access.push(input);
    return { allowed: false, error: 'unauthorized', status: 401 };
  }
  denyResourceAccessV1() { throw Error('unexpected_resource_denial'); }
  async financial(operation, input, receivedTrace) {
    finance.push({ operation, input, traceId: receivedTrace });
    return { status: settings.retryFirst && finance.length === 1 ? 'unavailable' : settings.outcome ?? 'ok' };
  }
}`;
const collaborators = {
  pg: `import { env } from 'cloudflare:workers'; export class Client {
    on() {} async connect() {} async query(sql) { return env.TEST_STATE.query(sql); } async end() {}
  }`,
  probe: `import { env } from 'cloudflare:workers'; export async function databaseProbe(connection) { return env.TEST_STATE.probe(connection); }`,
  finance: `import { env } from 'cloudflare:workers'; export function createPolicyFinance() { return {
    acceptOffer: (input, trace) => env.TEST_STATE.financial('accept', input, trace),
    consumeParametricEvent: (input, trace) => env.TEST_STATE.financial('parametric', input, trace),
    get: input => env.TEST_STATE.financial('get', input),
    getByAcceptance: input => env.TEST_STATE.financial('lookup', input),
    issue: input => env.TEST_STATE.financial('issue', input)
  }; }`,
};
const caller = `export default { async fetch(request, env) {
  const operation = new URL(request.url).pathname;
  const value = operation === '/acquisition' ? await env.ACQUISITION.infraStatus()
    : operation === '/policy' ? await env.POLICY.infraStatus()
    : await env.POLICY.acceptOfferV1(await request.json());
  return Response.json(value);
} };`;

async function bundle(entry) {
  return (await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:*', 'node:*'],
    plugins: [{ name: 'explicit-runtime-collaborators', setup(builder) {
      builder.onResolve({ filter: /^pg$|outbound\/database-probe$|adapters\/composition$/ }, args => ({
        path: args.path === 'pg' ? 'pg' : args.path.endsWith('database-probe') ? 'probe' : 'finance', namespace: 'runtime-collaborator',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'runtime-collaborator' }, args => ({ contents: collaborators[args.path], loader: 'js' }));
    } }, ...runtimeCoveragePlugins()],
  })).outputFiles[0].text;
}

test('financial entrypoints preserve authorization, owner bindings, cron failures and Queue retry semantics in workerd', { timeout: 30_000 }, async t => {
  const [acquisition, policy] = await Promise.all(['acquisition-risk', 'policy-claims-payments'].map(name => bundle(`backend/${name}/src/index.ts`)));
  const config = JSON.parse(await readFile('backend/acquisition-risk/wrangler.jsonc', 'utf8'));
  const worker = (name, script, overrides = {}) => ({ name, modules: true, script,
    unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }], compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    bindings: { APP_ENV: 'local', FINANCIAL_PROVIDER_MODE: 'mock', FINANCIAL_EVENT_KEY: 'b'.repeat(64), QUOTE_HMAC_KEY: 'a'.repeat(64), SIGNAL_PROVIDER: 'direct_simulated',
      ...(script === policy ? { POLICY_DB: { connectionString: 'postgresql://synthetic.invalid/policy' } }
        : { ACQUISITION_DB: { connectionString: 'postgresql://synthetic.invalid/acquisition' } }), ...overrides },
    serviceBindings: { IDENTITY_SERVICE: 'state', TEST_STATE: 'state' },
  });
  const runtime = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, workers: [
    { ...worker('acquisition', acquisition), queueProducers: { FINANCIAL_EVENTS: 'financial' } },
    { ...worker('invalid', acquisition, { FINANCIAL_EVENT_KEY: 'invalid' }), queueProducers: { FINANCIAL_EVENTS: 'financial' } },
    worker('disabled', acquisition, { APP_ENV: 'prod' }),
    { ...worker('policy', policy), queueConsumers: { financial: { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 2 } } },
    { name: 'state', modules: true, script: stateScript, compatibilityDate: config.compatibility_date },
    { name: 'caller', modules: true, script: caller, compatibilityDate: config.compatibility_date,
      serviceBindings: { ACQUISITION: 'acquisition', POLICY: 'policy' } },
  ] }));
  t.after(async () => {
    try { await captureRuntimeCoverage(runtime, ['acquisition', 'invalid', 'disabled', 'policy']); }
    finally { await runtime.dispose(); }
  });
  await runtime.ready;
  const state = await runtime.getWorker('state'), rpc = await runtime.getWorker('caller');
  const configure = async settings => { await state.fetch('http://state/configure', { method: 'POST', body: JSON.stringify(settings) }); };
  const snapshot = async () => (await state.fetch('http://state/')).json();
  const until = async predicate => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const result = await snapshot(); if (predicate(result)) return result;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Runtime did not reach the expected observable state');
  };

  await t.test('unauthorized HTTP never reaches owner persistence or the financial use case', async () => {
    await configure({});
    for (const [name, path, method] of [['acquisition', '/api/v1/offers/' + traceId + '/accept', 'POST'], ['policy', '/api/v1/policies/' + traceId, 'GET']]) {
      const endpoint = await runtime.unsafeGetDirectURL(name);
      const response = await fetch(new URL(path, endpoint), { method, headers: { 'X-Trace-Id': traceId } });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('x-trace-id'), traceId);
      assert.equal((await response.json()).error, 'unauthorized');
    }
    const result = await snapshot();
    assert.equal(result.access.length, 2);
    assert.deepEqual(result.queries, []); assert.deepEqual(result.finance, []);
  });
  await t.test('diagnostic RPC fails readiness for another database or Identity environment', async () => {
    await configure({});
    assert.equal((await (await rpc.fetch('http://rpc/acquisition')).json()).ready, true);
    assert.equal((await (await rpc.fetch('http://rpc/policy')).json()).ready, true);
    assert.deepEqual((await snapshot()).probes, ['postgresql://synthetic.invalid/acquisition', 'postgresql://synthetic.invalid/policy']);
    await configure({ database: 'solventa_staging', identityEnvironment: 'staging' });
    assert.equal((await (await rpc.fetch('http://rpc/acquisition')).json()).ready, false);
    assert.equal((await (await rpc.fetch('http://rpc/policy')).json()).ready, false);
  });
  await t.test('cron rejects invalid configuration before SQL and preserves disabled production behavior', async () => {
    await configure({});
    assert.equal((await (await runtime.getWorker('invalid')).scheduled({ cron: '* * * * *' })).outcome, 'exception');
    assert.equal((await (await runtime.getWorker('disabled')).scheduled({ cron: '* * * * *' })).outcome, 'ok');
    assert.deepEqual((await snapshot()).queries, []);
    assert.equal((await (await runtime.getWorker('acquisition')).scheduled({ cron: '* * * * *' })).outcome, 'ok');
    const published = await snapshot();
    assert.ok(published.queries.some(sql => sql.includes('UPDATE acquisition.outbox_events')));
    assert.ok(published.queries.every(sql => !sql.includes('policy.')));
    assert.deepEqual(published.finance, [], 'an empty outbox must not invoke Policy');
    await configure({ failQuery: true });
    assert.equal((await (await runtime.getWorker('acquisition')).scheduled({ cron: '* * * * *' })).outcome, 'exception');
  });
  await t.test('acceptance RPC preserves a valid correlation and replaces invalid correlation IDs', async () => {
    await configure({});
    for (const correlationId of [traceId, 'invalid']) {
      const response = await rpc.fetch('http://rpc/accept', { method: 'POST', body: JSON.stringify({ correlationId }) });
      assert.equal((await response.json()).status, 'ok');
    }
    const calls = (await snapshot()).finance;
    assert.equal(calls[0].traceId, traceId);
    assert.match(calls[1].traceId, /^[a-f0-9-]{36}$/);
    assert.notEqual(calls[1].traceId, 'invalid');
  });
  await t.test('Queue retries an unavailable acceptance and routes parametric messages to their own use case', async () => {
    await configure({ retryFirst: true });
    const queue = await runtime.getQueueProducer('FINANCIAL_EVENTS', 'acquisition');
    await queue.send({ eventType: 'offer.accepted', correlationId: traceId });
    const retried = await until(result => result.finance.length >= 2);
    assert.deepEqual(retried.finance.map(call => call.operation), ['accept', 'accept']);
    assert.ok(retried.finance.every(call => call.traceId === traceId));
    await configure({ outcome: 'denied' });
    await queue.send({ eventType: 'flight.delay', correlationId: 'invalid' });
    const parametric = await until(result => result.finance.length === 1);
    assert.equal(parametric.finance[0].operation, 'parametric');
    assert.match(parametric.finance[0].traceId, /^[a-f0-9-]{36}$/);
  });
});
