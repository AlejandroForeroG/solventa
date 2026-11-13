import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DraftSync } from '../apps/mobile/src/features/claim-drafts/application/draft-sync';
import { EncryptedDraftStorage } from '../apps/mobile/src/features/claim-drafts/adapters/encrypted-draft-storage';
import { DraftFailure, emptyDraft, type DraftCommand, type DraftVersion, type SyncReply } from '../apps/mobile/src/features/claim-drafts/domain/draft';
import type { DraftApi } from '../apps/mobile/src/features/claim-drafts/application/ports';
import { draftCustody } from './support/draft-custody';

function world() {
  const custody = draftCustody(), owner = { clientId: randomUUID(), subjectToken: randomUUID() };
  const draftId = randomUUID(), content = { ...emptyDraft(randomUUID()), description: 'Synthetic local note' };
  const calls: DraftCommand[] = [];
  let response: (command: DraftCommand) => Promise<SyncReply> = async command => ({ status: 'confirmed', merged: false,
    draft: { draftId, content: command.content, revision: 1, updatedAt: '2026-11-12T12:00:00.000Z' } });
  const api: DraftApi = { list: async () => [], get: async () => { throw Error('unused'); }, evidence: async () => [],
    sync: async (_, command) => { calls.push(structuredClone(command)); return response(command); } };
  const restart = () => new DraftSync({ storage: new EncryptedDraftStorage('https://staging.solventa.site', custody.port), api, newId: randomUUID, now: () => 123 });
  return { custody, owner, draftId, content, calls, restart, respond: (next: typeof response) => { response = next; } };
}
const entries = (engine: DraftSync) => { const snapshot = engine.getSnapshot(); assert.equal(snapshot.status, 'ready'); if (snapshot.status !== 'ready') throw Error('not ready'); return snapshot.entries; };

test('an explicit permanent refusal permits a corrected new intent while uncertain outcomes remain immutable', async () => {
  const w = world(), engine = w.restart(); await engine.open(w.owner); await engine.save(w.draftId, w.content);
  w.respond(async () => { throw new DraftFailure('rejected'); }); await engine.sync(w.owner);
  const refused = entries(engine)[0].command!;
  await engine.save(w.draftId, { ...w.content, place: 'Corrected by the customer' });
  assert.notEqual(entries(engine)[0].command?.commandId, refused.commandId);
  assert.equal(entries(engine)[0].command?.baseRevision, refused.baseRevision);
  w.respond(async () => { throw new DraftFailure('invalid_response'); }); await engine.sync(w.owner);
  await assert.rejects(engine.save(w.draftId, w.content));
});

test('offline edits survive restart and a lost acknowledgement retries the exact immutable command', async () => {
  const w = world(); let engine = w.restart(); await engine.open(w.owner);
  await engine.save(w.draftId, w.content); await engine.save(w.draftId, { ...w.content, place: 'Saved offline' });
  assert.equal(w.calls.length, 0); engine.lock(); engine = w.restart(); await engine.open(w.owner);
  w.respond(async () => { throw new DraftFailure('unavailable'); });
  await engine.sync(w.owner); assert.equal(entries(engine)[0].status, 'failed');
  await assert.rejects(engine.save(w.draftId, w.content));
  const sent = w.calls[0]; engine.lock(); engine = w.restart(); await engine.open(w.owner);
  w.respond(async command => ({ status: 'confirmed', merged: false, draft: { draftId: w.draftId, content: command.content, revision: 1, updatedAt: '2026-11-12T12:00:00Z' } }));
  await engine.sync(w.owner); assert.deepEqual(w.calls[1], sent); assert.equal(entries(engine)[0].status, 'confirmed');
  assert.equal(entries(engine)[0].command, null); assert.equal(entries(engine)[0].content.place, 'Saved offline');
  await engine.sync(w.owner); assert.equal(w.calls.length, 2);
});

test('an explicit conflict choice survives restart and an uncertain response without losing either version', async () => {
  const w = world(); let engine = w.restart(); await engine.open(w.owner); await engine.save(w.draftId, w.content);
  const base: DraftVersion = { draftId: w.draftId, revision: 1, content: w.content, updatedAt: '2026-11-12T12:00:00Z' };
  w.respond(async command => ({ status: 'conflict', conflict: { conflictId: command.commandId, draftId: w.draftId, base,
    server: { ...base, revision: 2, content: { ...w.content, description: 'Server note' } }, local: command.content, fields: ['description'], policy: 'claim-draft.fields.v1' } }));
  await engine.sync(w.owner); const conflict = entries(engine)[0].conflict;
  engine.lock(); engine = w.restart(); await engine.open(w.owner); assert.deepEqual(entries(engine)[0].conflict, conflict);
  await engine.resolve(w.draftId, 'server'); const choice = entries(engine)[0].command;
  engine.lock(); engine = w.restart(); await engine.open(w.owner); assert.deepEqual(entries(engine)[0].command, choice);
  w.respond(async () => { throw new DraftFailure('unavailable'); }); await engine.sync(w.owner);
  await engine.retry(w.draftId); await engine.sync(w.owner);
  assert.deepEqual(w.calls.at(-1), choice); assert.deepEqual(entries(engine)[0].conflict, conflict);
});

test('account isolation and locking during a request prevent a late result from exposing the old owner', async () => {
  const w = world(); const engine = w.restart(); await engine.open(w.owner); await engine.save(w.draftId, w.content);
  await engine.sync({ clientId: randomUUID(), subjectToken: randomUUID() }); assert.equal(w.calls.length, 0);
  let release!: (reply: SyncReply) => void; w.respond(() => new Promise(resolve => { release = resolve; }));
  const running = engine.sync(w.owner); while (!release) await new Promise(resolve => setImmediate(resolve));
  engine.lock(); release({ status: 'confirmed', merged: false, draft: { draftId: w.draftId, revision: 1, content: w.content, updatedAt: '2026-11-12T12:00:00Z' } });
  await running; assert.equal(engine.getSnapshot().status, 'locked');
  const other = w.restart(); await other.open({ clientId: randomUUID(), subjectToken: randomUUID() }); assert.equal(other.getSnapshot().status, 'failed');
  const restarted = w.restart(); await restarted.open(w.owner); assert.equal(entries(restarted)[0].status, 'pending');
  assert.deepEqual(entries(restarted)[0].command, w.calls[0]);
});

test('a failed durable sending transition never transmits, and a failed acknowledgement commit keeps the command', async () => {
  const w = world(); let engine = w.restart(); await engine.open(w.owner); await engine.save(w.draftId, w.content);
  w.custody.state.silentWrite = true; await engine.sync(w.owner); assert.equal(w.calls.length, 0);
  w.custody.state.silentWrite = false;
  w.respond(async command => { w.custody.state.silentWrite = true; return { status: 'confirmed', merged: false,
    draft: { draftId: w.draftId, revision: 1, content: command.content, updatedAt: '2026-11-12T12:00:00Z' } }; });
  await engine.sync(w.owner); assert.ok(entries(engine)[0].command); assert.notEqual(entries(engine)[0].status, 'confirmed');
  w.custody.state.silentWrite = false; engine.lock(); engine = w.restart(); await engine.open(w.owner);
  assert.deepEqual(entries(engine)[0].command, w.calls[0]);
});
