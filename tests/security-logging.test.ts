import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { databaseProbe as acquisitionProbe } from '../backend/acquisition-risk/src/adapters/outbound/database-probe';
import { databaseProbe as identityProbe } from '../backend/identity-consent-ecosystem/src/adapters/outbound/database-probe';
import { databaseProbe as policyProbe } from '../backend/policy-claims-payments/src/adapters/outbound/database-probe';
import { safeCode as acquisitionCode } from '../backend/acquisition-risk/src/adapters/safe-code';
import { safeCode as identityCode } from '../backend/identity-consent-ecosystem/src/adapters/safe-code';
import { safeCode as policyCode } from '../backend/policy-claims-payments/src/adapters/safe-code';
import { SqlSecurityDecisions } from '../backend/identity-consent-ecosystem/src/adapters/outbound/sql-security-decisions';
import { securityDecision } from '../backend/identity-consent-ecosystem/src/domain/security-decision';

const privateCode = 'SyntheticPerson123';
const privateDetail = 'synthetic-person@example.test private provider detail';

test('security persistence failures expose only the phase and an allowlisted technical code', async t => {
  const decision = securityDecision({ category: 'api_access', channel: 'partner', operation: 'quotes:create', cause: 'unauthorized' },
    '50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002');
  for (const phase of ['connect', 'write'] as const) for (const code of ['08P01', '42501', privateCode]) {
    const logs: string[] = [];
    let closed = false;
    const failure = Object.assign(new Error(privateDetail), { code, detail: privateDetail });
    t.mock.method(Client.prototype, 'connect', async () => { if (phase === 'connect') throw failure; });
    t.mock.method(Client.prototype, 'query', async () => { throw failure; });
    t.mock.method(Client.prototype, 'end', async () => { closed = true; });
    t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args.join(' ')); });
    try {
      await assert.rejects(new SqlSecurityDecisions('postgresql://synthetic.invalid/unused').append(decision), error => error === failure);
      assert.deepEqual(logs.map(line => JSON.parse(line)), [{ event: 'security_denial_persistence_failed', phase,
        code: code === privateCode ? 'unexpected_error' : code }]);
      assert.ok(closed);
    } finally { t.mock.restoreAll(); }
  }
});

function hostileMetadata() {
  const getter = Object.defineProperty({}, 'code', { get() { throw new Error(privateDetail); } });
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(privateDetail); } });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  return [getter, proxy, revoked.proxy];
}

for (const [owner, safeCode] of [['acquisition', acquisitionCode], ['identity', identityCode], ['policy', policyCode]] as const) {
  test(`${owner}: error metadata cannot disclose arbitrary identifiers or run accessors`, () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, 'code', { get() { reads++; return '40001'; } });
    assert.equal(safeCode(accessor), 'unexpected_error');
    assert.equal(reads, 0, 'error-code getters must not execute');
    for (const error of [null, undefined, privateDetail, { code: privateCode }, { code: 'AL123' }, { code: 12345 },
      { code: { toString() { assert.fail('an error code must not be coerced'); } } },
      Object.create({ code: '40001' }), ...hostileMetadata()]) {
      assert.equal(safeCode(error), 'unexpected_error');
      assert.equal(safeCode(error, 'connection_failed'), 'connection_failed');
    }
    for (const code of ['40001', '23505', '42501', '42P01', 'ECONNREFUSED', 'ETIMEDOUT', 'CERT_HAS_EXPIRED']) {
      assert.equal(safeCode(Object.assign(new Error(privateDetail), { code, detail: privateDetail })), code);
    }
  });
}

test('the acquisition HMAC configuration failure retains its operational code', () => {
  assert.equal(acquisitionCode({ code: 'quote_hmac_key_invalid' }), 'quote_hmac_key_invalid');
});

for (const [owner, probe] of [['acquisition', acquisitionProbe], ['identity', identityProbe], ['policy', policyProbe]] as const) {
  test(`${owner}: database diagnostics sanitize both their log and returned code`, async t => {
    for (const [failure, expected] of [
      [Object.assign(new Error(privateDetail), { code: privateCode, detail: privateDetail }), 'connection_failed'],
      [{ code: 'AL123' }, 'connection_failed'],
      [null, 'connection_failed'],
      ...hostileMetadata().map(error => [error, 'connection_failed']),
      [Object.assign(new Error(privateDetail), { code: '42501', detail: privateDetail }), '42501'],
      [{ code: 'ECONNREFUSED' }, 'ECONNREFUSED'],
    ] as const) {
      const logs: string[] = [];
      let ended = false;
      t.mock.method(Client.prototype, 'connect', async () => { throw failure; });
      t.mock.method(Client.prototype, 'end', async () => { ended = true; });
      t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args.join(' ')); });
      try {
        assert.deepEqual(await probe('postgresql://synthetic.invalid/unused'), { ready: false, code: expected });
        assert.deepEqual(logs.map(line => JSON.parse(line)), [{ event: 'database_probe_failed', code: expected }]);
        assert.ok(ended, 'the failed connection is closed');
      } finally { t.mock.restoreAll(); }
    }
  });
}
