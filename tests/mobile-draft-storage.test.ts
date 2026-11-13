import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { EncryptedDraftStorage } from '../apps/mobile/src/features/claim-drafts/adapters/encrypted-draft-storage';
import { emptyDraft, type DraftEntry } from '../apps/mobile/src/features/claim-drafts/domain/draft';
import { draftCustody } from './support/draft-custody';

const baseUrl = 'https://staging.solventa.site';
const owner = () => ({ clientId: randomUUID(), subjectToken: randomUUID() });
const entry = (): DraftEntry => {
  const content = { ...emptyDraft(randomUUID()), description: 'Synthetic confidential incident note' };
  return { draftId: randomUUID(), content, confirmed: null, command: { commandId: randomUUID(), baseRevision: 0, content }, status: 'pending', attempted: false, savedAt: 123 };
};

test('an encrypted pending action survives a fresh coordinator and plaintext is absent from the file and metadata', async () => {
  const h = draftCustody(), who = owner(), action = entry();
  const store = new EncryptedDraftStorage(baseUrl, h.port);
  await assert.rejects(store.read(who));
  await store.unlock(); await store.write(who, [action]); store.lock();
  assert.ok(h.state.meta && !h.state.meta.includes(action.content.description));
  assert.ok([...h.state.blobs.values()].every(bytes => !Buffer.from(bytes).includes(Buffer.from(action.content.description))));
  const restarted = new EncryptedDraftStorage(baseUrl, h.port);
  await restarted.unlock(); assert.deepEqual(await restarted.read(who), { owner: who, entries: [action] });
  assert.equal(h.state.prompts, 2);
});

test('a silently refused pointer commit leaves the last acknowledged generation intact', async () => {
  const h = draftCustody(), who = owner(), first = entry();
  const store = new EncryptedDraftStorage(baseUrl, h.port);
  await store.unlock(); await store.write(who, [first]);
  h.state.silentWrite = true;
  await assert.rejects(store.write(who, [first, entry()]));
  assert.deepEqual((await store.read(who))?.entries, [first]);
});

test('owner, installation, environment and authenticated ciphertext cannot be substituted', async () => {
  const h = draftCustody(), who = owner();
  const store = new EncryptedDraftStorage(baseUrl, h.port);
  await store.unlock(); await store.write(who, [entry()]);
  await assert.rejects(store.read(owner()));
  const otherEnvironment = new EncryptedDraftStorage('https://dev.solventa.site', h.port);
  await otherEnvironment.unlock(); await assert.rejects(otherEnvironment.read(who));
  const originalInstallation = h.state.installation;
  h.state.installation = randomUUID(); await assert.rejects(store.read(who)); h.state.installation = originalInstallation;
  const meta = JSON.parse(h.state.meta!); const bytes = h.state.blobs.get(meta.file)!; bytes[15] ^= 1;
  await assert.rejects(store.read(who));
});

test('a refused removal stays guarded after restart and a later clear finishes the debt', async () => {
  const h = draftCustody(), who = owner(), store = new EncryptedDraftStorage(baseUrl, h.port);
  await store.unlock(); await store.write(who, [entry()]);
  h.state.refuseRemoval = true; await assert.rejects(store.clear());
  const restarted = new EncryptedDraftStorage(baseUrl, h.port);
  await restarted.unlock(); await assert.rejects(restarted.read(who));
  h.state.refuseRemoval = false; await restarted.clear(); await restarted.unlock();
  assert.equal(await restarted.read(who), null); assert.equal(h.state.blobs.size, 0);
});

test('logout wins over an in-flight encryption and no late pointer can resurrect an action', async () => {
  const h = draftCustody(), who = owner();
  const seal = h.port.seal;
  let release!: () => void; let started!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  h.port.seal = async (...args) => { started(); await barrier; return seal(...args); };
  const store = new EncryptedDraftStorage(baseUrl, h.port); await store.unlock();
  const writing = store.write(who, [entry()]); const rejected = assert.rejects(writing);
  await entered; const clearing = store.clear(); release(); await rejected; await clearing;
  assert.equal(h.state.meta, null); assert.equal(h.state.blobs.size, 0);
});

test('unprotected devices write nothing and only explicitly projected entry fields can rest on disk', async () => {
  const h = draftCustody(), who = owner(), store = new EncryptedDraftStorage(baseUrl, h.port);
  h.state.available = false; await assert.rejects(store.unlock()); assert.equal(h.state.meta, null);
  h.state.available = true; await store.unlock();
  const action = Object.assign(entry(), { accessToken: 'must-never-rest' });
  await store.write(who, [action]); const loaded = await store.read(who);
  assert.ok(!JSON.stringify(loaded).includes('must-never-rest'));
  await assert.rejects(store.write(who, Array.from({ length: 21 }, entry)));
});
