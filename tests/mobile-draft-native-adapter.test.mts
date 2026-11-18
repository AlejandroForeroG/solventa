import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

// The mocked native adapters load through CommonJS; use the same class identities in this ESM harness.
const require = createRequire(import.meta.url);
const { PolicyCacheFailure } = require('../apps/mobile/src/features/policy-cache/domain/cached-policy') as typeof import('../apps/mobile/src/features/policy-cache/domain/cached-policy');
const { DraftFailure } = require('../apps/mobile/src/features/claim-drafts/domain/draft') as typeof import('../apps/mobile/src/features/claim-drafts/domain/draft');

const adapter = new URL('../apps/mobile/src/features/claim-drafts/adapters/', import.meta.url);
const metadata = 'solventa.claim-drafts.v1', marker = 'solventa.claim-drafts.discard.v1';
const values = new Map<string, string>(); let available = true, refuseSettle = false, cancelPrompt = false;
mock.module('expo-secure-store', { namedExports: {
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 1, isAvailableAsync: async () => available,
  getItemAsync: async (key: string) => values.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { if (!(refuseSettle && value === '0')) values.set(key, value); },
  deleteItemAsync: async (key: string) => { if (key !== marker) values.delete(key); },
} });
mock.module('expo-crypto', { namedExports: { AESEncryptionKey: {}, AESSealedData: {}, aesDecryptAsync() {}, aesEncryptAsync() {}, randomUUID } });
mock.module('expo-file-system', { namedExports: { Directory: class { exists = false; }, File: class {}, Paths: { document: 'synthetic-private-path' } } });
mock.module(new URL('../../../shared/native/installation-marker.ts', adapter).href, { namedExports: { installationMarker: randomUUID } });
mock.module(new URL('../../policy-cache/adapters/device-authentication.ts', adapter).href,
  { namedExports: { deviceAuthentication: { authenticate: async () => { if (cancelPrompt) throw new PolicyCacheFailure('locked'); } }, deviceLockAvailable: async () => true } });
const { protectedDraftStorage } = await import('../apps/mobile/src/features/claim-drafts/adapters/native-draft-storage');
let offlinePromptCancelled = false;
const offlineCalls: string[] = [];
mock.module(new URL('../../policy-cache/adapters/secure-policy-store.ts', adapter).href, { namedExports: { protectedPolicyCache: {
  unlock: async () => { offlineCalls.push('unlock'); if (offlinePromptCancelled) throw new PolicyCacheFailure('locked'); },
  readLatest: async () => { offlineCalls.push('read'); return null; }, lock: () => offlineCalls.push('lock'),
} } });
const { openDraftWorkspace } = await import('../apps/mobile/src/features/claim-drafts/adapters/open-draft-workspace');

test('cancelling the device prompt stays locked and does not report a storage failure or change custody', async () => {
  const before = [...values]; cancelPrompt = true;
  await assert.rejects(protectedDraftStorage.unlock(), error => error instanceof DraftFailure && error.kind === 'locked');
  assert.deepEqual([...values], before); cancelPrompt = false;
});

test('cancelling the offline owner prompt locks the policy cache without reading data or opening drafts', async () => {
  offlineCalls.length = 0; offlinePromptCancelled = true;
  const sync = { open: async () => { offlineCalls.push('drafts'); } };
  await assert.rejects(openDraftWorkspace(sync as never), error => error instanceof DraftFailure && error.kind === 'locked');
  assert.deepEqual(offlineCalls, ['unlock', 'lock']); offlinePromptCancelled = false;
});

test('a silently refused discard-marker delete can settle only after the encryption pointer is erased', async () => {
  values.set(metadata, 'synthetic key pointer'); await protectedDraftStorage.clear();
  assert.equal(values.has(metadata), false); assert.equal(values.get(marker), '0');
});
test('a refused marker settlement remains guarded rather than reporting successful logout cleanup', async () => {
  values.set(metadata, 'synthetic key pointer'); refuseSettle = true;
  await assert.rejects(protectedDraftStorage.clear()); assert.equal(values.has(metadata), false); assert.equal(values.get(marker), '1');
  refuseSettle = false; await protectedDraftStorage.clear(); assert.equal(values.get(marker), '0');
});
test('unsupported web custody has no data to erase and does not break the existing authentication clear path', async () => {
  available = false; await protectedDraftStorage.clear(); available = true;
});
