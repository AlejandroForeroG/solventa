import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createHttp } from '../backend/policy-claims-payments/src/adapters/inbound/http';
import { lifecycleFixture, lifecycleRecord } from './support/policy-lifecycle-fixture';
const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv);
for (const name of ['common', 'policies']) ajv.addSchema({ ...parse(readFileSync(`packages/contracts/openapi/v1/${name}.yaml`, 'utf8')), $id: `https://solventa.test/v1/${name}.yaml` });

test('the customer notice contract rejects malformed owner identifiers and timestamps', () => {
  const validate = ajv.compile(JSON.parse(readFileSync('packages/contracts/schemas/policy-lifecycle-notice.v1.json', 'utf8')));
  const notice = { category: 'policy_lifecycle_changed', clientId: randomUUID(), policyId: randomUUID(), changeId: randomUUID(),
    action: 'cancelled', changedAt: '2026-11-11T12:00:00.000Z', replacementPolicyId: null, refund: 'not_automated' };
  assert.equal(validate(notice), true);
  for (const field of ['clientId', 'policyId', 'changeId']) assert.equal(validate({ ...notice, [field]: '-'.repeat(36) }), false);
  assert.equal(validate({ ...notice, changedAt: '2026-99-99T:Z' }), false);
});

test('owner lifecycle HTTP validates the command and returns the contracted committed state; native sync omits ended coverage', async () => {
  const record = await lifecycleRecord(), fixture = lifecycleFixture([record]);
  const actor = { clientId: record.policy.clientId, subjectToken: record.policy.subjectToken };
  const app = createHttp({ finance: fixture.finance, denyResourceAccess: async () => ({ recorded: true }),
    authorizeFinancialAccess: async (raw: unknown) => {
      const input = raw as { kind: string; operation: string };
      return { allowed: true, actor: { kind: 'user', channel: input.kind, principal: actor, operations: [input.operation] } };
    } });
  const url = `https://web.example/api/v1/policies/${record.policy.id}/lifecycle`;
  const command = { action: 'cancelled', replacementPolicyId: null, documentHash: record.policy.documentHash, reason: 'customer_request' };
  const key = randomUUID();
  const request = (body: unknown = command, headerKey = key, method = 'POST') => app.request(url, {
    method, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}), headers: { 'content-type': 'application/json', cookie: 'solventa-session=synthetic-sealed',
      origin: 'https://web.example', 'idempotency-key': headerKey } }, { APP_ENV: 'local' } as PolicyEnv);
  assert.equal((await request(command, '')).status, 400);
  assert.equal((await request({ ...command, clientId: actor.clientId })).status, 400);
  assert.equal((await request(command, key, 'GET')).status, 405);
  const response = await request(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json(); const validate = ajv.getSchema('https://solventa.test/v1/policies.yaml#/components/schemas/Policy');
  assert.ok(validate); assert.equal(validate(body), true, JSON.stringify(validate.errors));
  assert.equal(body.lifecycle.action, 'cancelled'); assert.equal(body.payment.status, 'confirmed');
  assert.equal((await (await request()).json()).replayed, true);
  const native = await app.request('https://web.example/api/v1/policies', { headers: { authorization: 'Bearer synthetic-native' } }, { APP_ENV: 'local' } as PolicyEnv);
  assert.equal(native.status, 200); assert.deepEqual((await native.json()).policies, []);
  const web = await app.request('https://web.example/api/v1/policies/issued', { headers: { cookie: 'solventa-session=synthetic-sealed' } }, { APP_ENV: 'local' } as PolicyEnv);
  assert.equal(web.status, 200); assert.equal((await web.json()).policies[0].contractStatus, 'cancelled');
});

test('a partner or native principal cannot use the owner web mutation even if access returns an operation', async () => {
  const record = await lifecycleRecord(), fixture = lifecycleFixture([record]);
  for (const channel of ['mobile', 'partner']) {
    const app = createHttp({ finance: fixture.finance, denyResourceAccess: async () => ({ recorded: true }),
      authorizeFinancialAccess: async () => ({ allowed: true, actor: { kind: channel === 'partner' ? 'partner' : 'user', channel,
        principal: { clientId: record.policy.clientId, subjectToken: record.policy.subjectToken }, operations: ['policies:manage'] } }) });
    const response = await app.request(`https://web.example/api/v1/policies/${record.policy.id}/lifecycle`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }, { APP_ENV: 'local' } as PolicyEnv);
    assert.equal(response.status, 503); assert.equal(fixture.record(record.policy.id)?.policy.lifecycle, undefined);
  }
});
