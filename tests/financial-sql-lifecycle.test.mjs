import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('wrangler/package.json'))('esbuild');
const bundled = (await build({ stdin: { contents: `
  export { SqlFinancialStore } from './backend/policy-claims-payments/src/adapters/outbound/sql-financial-store';
  export { SqlMockPaymentGateway } from './backend/policy-claims-payments/src/adapters/outbound/mock-financial-providers';
  export { configure } from 'pg';`, resolveDir: process.cwd() },
bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'explicit-sql-transport', setup(builder) {
  builder.onResolve({ filter: /^pg$/ }, () => ({ path: 'pg', namespace: 'transport' }));
  builder.onLoad({ filter: /.*/, namespace: 'transport' }, () => ({ contents: `
    let state;
    export function configure(value) { state = value; }
    export class Client {
      on() {} async connect() { state.connected++; }
      query(sql, args) { state.queries.push(sql); return state.query(sql, args); }
      end() { state.closes++; return state.close(); }
    }` }));
} }] })).outputFiles[0].text;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const module = await import('data:text/javascript;base64,' + Buffer.from(bundled).toString('base64') + '#' + randomUUID());
  const state = { connected: 0, closes: 0, queries: [], query: async () => ({ rows: [], rowCount: 0 }), close: async () => {} };
  module.configure(state);
  return { ...module, state };
}

// The real SQL adapters execute against an explicit controlled transport. These
// ordering tests supplement, and never replace, the real financial SQL suite.
test('a transaction cannot report its value before COMMIT, but retains a blocked close after COMMIT', async () => {
  const f = await fixture(), committing = deferred(), commit = deferred(), close = deferred(), background = [];
  f.state.query = async sql => { if (sql === 'COMMIT') { committing.resolve(); await commit.promise; } return { rows: [], rowCount: 0 }; };
  f.state.close = () => close.promise;
  const store = new f.SqlFinancialStore('synthetic-transport', { waitUntil: work => background.push(work) });
  let returned = false;
  const result = store.transaction(async () => 17).then(value => { returned = true; return value; });
  await committing.promise;
  assert.equal(returned, false); assert.equal(f.state.closes, 0); assert.equal(background.length, 0);
  commit.resolve(); assert.equal(await result, 17);
  assert.equal(f.state.closes, 1); assert.equal(background.length, 1);
  let closed = false; const retained = background[0].then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  close.resolve(); await retained; assert.equal(closed, true);
});

test('failed work waits for ROLLBACK and preserves its error while retaining transport teardown', async () => {
  const f = await fixture(), rolling = deferred(), rollback = deferred(), close = deferred(), background = [];
  f.state.query = async sql => { if (sql === 'ROLLBACK') { rolling.resolve(); await rollback.promise; } return { rows: [], rowCount: 0 }; };
  f.state.close = () => close.promise;
  const store = new f.SqlFinancialStore('synthetic-transport', { waitUntil: work => background.push(work) });
  const failure = new Error('synthetic_failed_work');
  const rejection = assert.rejects(store.transaction(async () => { throw failure; }), error => error === failure);
  await rolling.promise; assert.equal(f.state.closes, 0); assert.equal(background.length, 0);
  rollback.resolve(); await rejection;
  assert.deepEqual(f.state.queries, ['BEGIN', 'ROLLBACK']); assert.equal(background.length, 1);
  close.resolve(); await Promise.all(background);
});

test('a failed COMMIT cannot become a success when teardown runs in the background', async () => {
  const f = await fixture(), close = deferred(), background = [];
  const failure = new Error('synthetic_commit_failure');
  f.state.query = async sql => { if (sql === 'COMMIT') throw failure; return { rows: [], rowCount: 0 }; };
  f.state.close = () => close.promise;
  const store = new f.SqlFinancialStore('synthetic-transport', { waitUntil: work => background.push(work) });
  await assert.rejects(store.transaction(async () => 'uncommitted'), error => error === failure);
  assert.deepEqual(f.state.queries, ['BEGIN', 'COMMIT', 'ROLLBACK']); assert.equal(background.length, 1);
  close.resolve(); await Promise.all(background);
});

for (const mode of ['absent', 'rejected']) test(`cleanup is awaited when the invocation context is ${mode}`, async () => {
  const f = await fixture(), closing = deferred(), close = deferred();
  f.state.close = () => { closing.resolve(); return close.promise; };
  const lifecycle = mode === 'absent' ? undefined : { waitUntil() { throw Error('unavailable_context'); } };
  const store = new f.SqlFinancialStore('synthetic-transport', lifecycle);
  let returned = false;
  const result = store.transaction(async () => true).then(value => { returned = true; return value; });
  await closing.promise; await Promise.resolve(); assert.equal(returned, false);
  close.resolve(); assert.equal(await result, true);
});

const payment = { id: '80000000-0000-4000-8000-000000000001', policyId: '80000000-0000-4000-8000-000000000002',
  operation: 'premium', amount: '24300.00', currency: 'COP', key: 'initial-premium', hash: 'a'.repeat(64), status: 'pending', providerReference: null };
const gatewayRow = { request_hash: payment.hash, operation: payment.operation, amount: payment.amount,
  currency: payment.currency, status: 'confirmed', provider_reference: 'MOCK-' + payment.id };

test('a fresh gateway settlement validates the returned durable row without a second query', async () => {
  const f = await fixture(), close = deferred(), background = [];
  f.state.query = async () => ({ rows: [gatewayRow], rowCount: 1 }); f.state.close = () => close.promise;
  const gateway = new f.SqlMockPaymentGateway('synthetic-transport', { waitUntil: work => background.push(work) });
  assert.deepEqual(await gateway.settle(payment), { status: 'confirmed', reference: gatewayRow.provider_reference });
  assert.equal(f.state.queries.length, 1); assert.match(f.state.queries[0], /RETURNING/);
  assert.equal(background.length, 1); close.resolve(); await Promise.all(background);
});

test('gateway collisions still validate the original operation and never overwrite an existing refund', async () => {
  for (const row of [{ ...gatewayRow, status: 'refunded' }, { ...gatewayRow, request_hash: 'b'.repeat(64) }, { ...gatewayRow, amount: '1.00' }, null]) {
    const f = await fixture();
    f.state.query = async sql => sql.startsWith('INSERT') ? { rows: [], rowCount: 0 } : { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    const gateway = new f.SqlMockPaymentGateway('synthetic-transport');
    if (row?.status === 'refunded') assert.deepEqual(await gateway.settle(payment), { status: 'declined', reference: gatewayRow.provider_reference });
    else await assert.rejects(gateway.settle(payment), /mock_gateway_(conflict|unavailable)/);
    assert.equal(f.state.queries.length, 2); assert.match(f.state.queries[0], /ON CONFLICT\(payment_id\) DO NOTHING/);
    assert.match(f.state.queries[1], /^SELECT/); assert.equal(f.state.closes, 1);
  }
});
