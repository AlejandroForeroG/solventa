import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { canonicalDraftCommand, mergeDraft, parseDraftCommand, parseDraftContent, sameDraftContent, type DraftContent } from '../backend/policy-claims-payments/src/domain/claim-draft';

const policyId = '10000000-0000-4000-8000-000000000001';
const content = (): DraftContent => ({ policyId, eventType: null, occurredAt: null, place: '', description: '', evidence: [] });

test('evidence identity ignores JSONB object-key order and reference-set order', () => {
  const first = { claimId: randomUUID(), fileId: randomUUID() }, second = { claimId: randomUUID(), fileId: randomUUID() };
  const local = { ...content(), evidence: [first, second] };
  const persisted = { ...content(), evidence: [{ fileId: second.fileId, claimId: second.claimId }, { fileId: first.fileId, claimId: first.claimId }] };
  assert.ok(sameDraftContent(local, persisted));
  assert.deepEqual(mergeDraft(persisted, { ...local, description: 'Local note' }, { ...persisted, place: 'Server place' }).conflicts, []);
  assert.equal(mergeDraft(persisted, local, persisted).content.description, '');
});

test('an incomplete draft is allowed but contractual and unknown data never enters it', () => {
  assert.deepEqual(parseDraftContent(content()), content());
  for (const extra of ['premium', 'payment', 'consent', 'owner', 'status']) assert.equal(parseDraftContent({ ...content(), [extra]: true }), null);
  for (const description of ['\u0000', 'x'.repeat(601)]) assert.equal(parseDraftContent({ ...content(), description }), null);
  assert.equal(parseDraftContent({ ...content(), place: 'a\nb' }), null);
  assert.equal(parseDraftContent({ ...content(), occurredAt: '2026-02-30T10:00:00.000Z' }), null);
});

test('evidence is a bounded unique set of server references, never arbitrary paths', () => {
  const ref = { claimId: randomUUID(), fileId: randomUUID() };
  assert.equal(parseDraftContent({ ...content(), evidence: [ref, ref] }), null);
  assert.equal(parseDraftContent({ ...content(), evidence: [{ ...ref, uri: '/foreign/file' }] }), null);
  assert.equal(parseDraftContent({ ...content(), evidence: [{ claimId: '../other', fileId: ref.fileId }] }), null);
  assert.equal(parseDraftContent({ ...content(), evidence: Array.from({ length: 11 }, () => ({ claimId: randomUUID(), fileId: randomUUID() })) }), null);
});

test('commands bind their stable identity, base revision and exact intent', () => {
  const command = { commandId: randomUUID(), baseRevision: 0, content: content() };
  assert.deepEqual(parseDraftCommand(command), command);
  for (const baseRevision of [-1, 0.5, 1_000_001, '1', null]) assert.equal(parseDraftCommand({ ...command, baseRevision }), null);
  assert.equal(parseDraftCommand({ ...command, resolution: { conflictId: randomUUID(), keep: 'newest' } }), null);
  assert.notEqual(canonicalDraftCommand(randomUUID(), command), canonicalDraftCommand(randomUUID(), command));
  assert.notEqual(canonicalDraftCommand(policyId, command), canonicalDraftCommand(policyId, { ...command, content: { ...command.content, description: 'edited' } }));
});

test('disjoint and identical edits merge, preserving both writers without last-write-wins', () => {
  const base = content();
  const local = { ...base, description: 'Local account of the incident' };
  const server = { ...base, place: 'Synthetic street' };
  assert.deepEqual(mergeDraft(base, local, server), { content: { ...server, description: local.description }, conflicts: [] });
  assert.deepEqual(mergeDraft(base, local, local), { content: local, conflicts: [] });
  assert.equal(sameDraftContent(local, { evidence: [], description: local.description, place: '', occurredAt: null, eventType: null, policyId }), true);
});

test('incompatible field edits remain a conflict while compatible fields are conserved', () => {
  const base = content();
  const local = { ...base, description: 'Local version', place: 'Local place' };
  const server = { ...base, description: 'Server version' };
  const decision = mergeDraft(base, local, server);
  assert.deepEqual(decision.conflicts, ['description']);
  assert.equal(decision.content.description, 'Server version');
  assert.equal(decision.content.place, 'Local place');
});

test('concurrent evidence additions merge but a competing deletion requires intervention', () => {
  const a = { claimId: randomUUID(), fileId: randomUUID() };
  const b = { claimId: randomUUID(), fileId: randomUUID() };
  const c = { claimId: randomUUID(), fileId: randomUUID() };
  const base = { ...content(), evidence: [a] };
  const added = mergeDraft(base, { ...base, evidence: [a, b] }, { ...base, evidence: [a, c] });
  assert.deepEqual(added.conflicts, []);
  assert.equal(added.content.evidence.length, 3);
  assert.deepEqual(mergeDraft(base, { ...base, evidence: [] }, { ...base, evidence: [a, c] }).conflicts, ['evidence']);
});
