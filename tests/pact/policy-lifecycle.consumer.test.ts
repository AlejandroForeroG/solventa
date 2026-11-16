import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { PactV3, MatchersV3 } from '@pact-foundation/pact';
import { changePolicyLifecycle } from '../../apps/web/src/policies/api';
import { lifecyclePactRecord, lifecycleIds } from './support/policy-lifecycle';
import { assertMatchesCommitted, pactOutputDir, providerName } from './support/pact-files';
const consumer = 'solventa-policy-lifecycle-web', output = pactOutputDir();
const pact = new PactV3({ consumer, provider: providerName, dir: output, logLevel: 'error' });
after(() => assertMatchesCommitted(output, `${consumer}-${providerName}.json`));
test('the policy portal submits an owner cancellation and recognizes its confirmed versioned state', async () => {
  const record = await lifecyclePactRecord();
  const command = { action: 'cancelled' as const, replacementPolicyId: null, documentHash: record.policy.documentHash, reason: 'customer_request' };
  pact.given('an owner with an active lifecycle policy').uponReceiving('an owner policy cancellation without automatic refund')
    .withRequest({ method: 'POST', path: `/api/v1/policies/${lifecycleIds.policyId}/lifecycle`, headers: { 'content-type': 'application/json', 'idempotency-key': 'lifecycle-cancellation-1' }, body: command })
    .willRespondWith({ status: 200, headers: { 'Content-Type': 'application/json' }, body: { policyId: lifecycleIds.policyId,
      traceId: MatchersV3.uuid('50000000-0000-4000-8000-000000000001'), lifecycle: { action: 'cancelled', at: MatchersV3.iso8601DateTimeWithMillis('2026-10-16T02:01:00.000Z'), reason: 'customer_request', replacementPolicyId: null } } });
  await pact.executeTest(async server => {
    const original = globalThis.fetch;
    globalThis.fetch = (input, init) => original(typeof input === 'string' && input.startsWith('/') ? server.url + input : input, init);
    try { assert.equal(await changePolicyLifecycle(lifecycleIds.policyId, command, 'lifecycle-cancellation-1'), 'confirmed'); }
    finally { globalThis.fetch = original; }
  });
});
