import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { randomUUID } from 'node:crypto';

const adapter = new URL('../apps/mobile/src/features/claim-drafts/adapters/', import.meta.url);
const metadata = 'solventa.claim-drafts.v1', marker = 'solventa.claim-drafts.discard.v1';
const values = new Map<string, string>(); let available = true, refuseSettle = false;
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
  { namedExports: { deviceAuthentication: { authenticate: async () => {} }, deviceLockAvailable: async () => true } });
const { protectedDraftStorage } = await import('../apps/mobile/src/features/claim-drafts/adapters/native-draft-storage');

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
