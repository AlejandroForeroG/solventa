import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lifecycleFixture, lifecycleRecord } from './support/policy-lifecycle-fixture';
const inputFor = (record: Awaited<ReturnType<typeof lifecycleRecord>>) => ({ actor: { clientId: record.policy.clientId, subjectToken: record.policy.subjectToken },
  policyId: record.policy.id, action: 'cancelled' as const, replacementPolicyId: null, documentHash: record.policy.documentHash,
  reason: 'customer_request', idempotencyKey: randomUUID(), traceId: randomUUID() });
test('cancellation preserves the original signed evidence and confirmed premium, with one durable decision on replay', async () => {
  const record = await lifecycleRecord(), fixture = lifecycleFixture([record]), input = inputFor(record);
  const first = await fixture.finance.changeLifecycle(input);
  assert.equal(first.status, 'ok');
  if (first.status !== 'ok') return;
  assert.equal(first.policy.lifecycle?.action, 'cancelled'); assert.equal(first.payment?.status, 'confirmed');
  assert.equal(first.policy.document, record.policy.document); assert.equal(first.policy.documentHash, record.policy.documentHash);
  const second = await fixture.finance.changeLifecycle(input); assert.equal(second.status, 'ok');
  if (second.status === 'ok') assert.equal(second.replayed, true);
  assert.equal(fixture.captures.length, 1);
  const detail = await fixture.finance.detail({ actor: input.actor, policyId: input.policyId, traceId: input.traceId });
  assert.equal(detail.status, 'ok'); if (detail.status === 'ok') assert.equal(detail.detail.lifecycle?.action, 'cancelled');
  const pdf = await fixture.finance.document({ actor: input.actor, policyId: input.policyId, documentId: 'premium_receipt', traceId: input.traceId });
  assert.equal(pdf.status, 'ok'); if (pdf.status === 'ok') assert.ok(pdf.file.lines.some(line => line.includes('cancelled')));
});
test('modification requires an owned issued replacement and binds its independently signed document', async () => {
  const source = await lifecycleRecord(), input = inputFor(source);
  const replacement = await lifecycleRecord(input.actor, '2026-10-16T02:00:30.000Z');
  const fixture = lifecycleFixture([source, replacement]);
  const result = await fixture.finance.changeLifecycle({ ...input, action: 'modified', reason: 'coverage_change', replacementPolicyId: replacement.policy.id });
  assert.equal(result.status, 'ok'); if (result.status === 'ok') assert.equal(result.policy.lifecycle?.replacementDocumentHash, replacement.policy.documentHash);
  const foreign = await lifecycleRecord();
  const denied = await lifecycleFixture([source, foreign]).finance.changeLifecycle({ ...input, action: 'modified', replacementPolicyId: foreign.policy.id });
  assert.equal(denied.status, 'denied'); if (denied.status === 'denied') assert.equal(denied.httpStatus, 404);
});
test('renewal uses a new issued offer after the previous validity and refuses an overlapping renewal', async () => {
  const source = await lifecycleRecord(), input = inputFor(source), replacement = await lifecycleRecord(input.actor, source.policy.effectiveUntil);
  const fixture = lifecycleFixture([source, replacement]);
  const request = { ...input, action: 'renewed' as const, reason: 'term_renewal', replacementPolicyId: replacement.policy.id };
  const early = await fixture.finance.changeLifecycle(request); assert.equal(early.status, 'denied');
  fixture.setNow(new Date(Date.parse(source.policy.effectiveUntil) + 60000).toISOString());
  assert.equal((await fixture.finance.changeLifecycle(request)).status, 'ok');
});
test('conflicting concurrent commands cannot both transition one policy, and a reused key cannot change its request', async () => {
  const source = await lifecycleRecord(), fixture = lifecycleFixture([source]), input = inputFor(source);
  const results = await Promise.all([fixture.finance.changeLifecycle(input), fixture.finance.changeLifecycle({ ...input, idempotencyKey: randomUUID() })]);
  assert.equal(results.filter(result => result.status === 'ok').length, 1); assert.equal(fixture.captures.length, 1);
  const changed = await fixture.finance.changeLifecycle({ ...input, reason: 'another_reason' });
  assert.equal(changed.status, 'denied'); if (changed.status === 'denied') assert.equal(changed.error, 'idempotency_conflict');
});

test('one replacement cannot end two contracts and a sealed lifecycle rejects altered history', async () => {
  const source = await lifecycleRecord(), input = inputFor(source), rival = await lifecycleRecord(input.actor), replacement = await lifecycleRecord(input.actor);
  const fixture = lifecycleFixture([source, rival, replacement]);
  const modify = { ...input, action: 'modified' as const, reason: 'coverage_change', replacementPolicyId: replacement.policy.id };
  assert.equal((await fixture.finance.changeLifecycle(modify)).status, 'ok');
  const conflict = await fixture.finance.changeLifecycle({ ...modify, policyId: rival.policy.id, documentHash: rival.policy.documentHash, idempotencyKey: randomUUID() });
  assert.equal(conflict.status, 'denied'); if (conflict.status === 'denied') assert.equal(conflict.httpStatus, 409);
  const saved = fixture.record(source.policy.id); assert.ok(saved?.policy.lifecycle); saved.policy.lifecycle.reason = 'altered_reason';
  const read = await fixture.finance.get({ ...input }); assert.equal(read.status, 'denied'); if (read.status === 'denied') assert.equal(read.error, 'integrity_violation');
});
test('failed persistence, foreign ownership, changed document and malformed input never report a successful transition', async () => {
  const source = await lifecycleRecord(), fixture = lifecycleFixture([source]), input = inputFor(source);
  fixture.fail(); assert.equal((await fixture.finance.changeLifecycle(input)).status, 'unavailable');
  assert.equal(fixture.record(source.policy.id)?.policy.lifecycle, undefined);
  for (const change of [{ actor: { ...input.actor, clientId: randomUUID() } }, { documentHash: 'a'.repeat(64) }, { reason: 'raw personal text' }]) {
    assert.equal((await lifecycleFixture([source]).finance.changeLifecycle({ ...input, ...change })).status, 'denied');
  }
});
