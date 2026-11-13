import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync, randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { installationMarker } from '../../../shared/native/installation-marker';
import { deviceAuthentication, deviceLockAvailable } from '../../policy-cache/adapters/device-authentication';
import { DraftFailure } from '../domain/draft';
import { EncryptedDraftStorage, type DraftCustody } from './encrypted-draft-storage';

const key = 'solventa.claim-drafts.v1';
const discardKey = 'solventa.claim-drafts.discard.v1';
const options = (service: string): SecureStore.SecureStoreOptions => ({ keychainService: service, keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY });
const directory = () => new Directory(Paths.document, 'solventa-claim-drafts-v1');
const custody: DraftCustody = {
  available: async () => await SecureStore.isAvailableAsync() && await deviceLockAvailable(),
  authenticate: () => deviceAuthentication.authenticate(),
  installationId: installationMarker,
  readMeta: async () => await SecureStore.isAvailableAsync() ? SecureStore.getItemAsync(key, options(key)) : null,
  writeMeta: value => SecureStore.setItemAsync(key, value, options(key)),
  removeMeta: async () => { if (await SecureStore.isAvailableAsync()) await SecureStore.deleteItemAsync(key, options(key)); },
  readDiscard: async () => await SecureStore.isAvailableAsync() && await SecureStore.getItemAsync(discardKey, options(discardKey)) === '1',
  writeDiscard: async () => { if (await SecureStore.isAvailableAsync()) await SecureStore.setItemAsync(discardKey, '1', options(discardKey)); },
  removeDiscard: async () => {
    if (!await SecureStore.isAvailableAsync()) return;
    await SecureStore.deleteItemAsync(discardKey, options(discardKey));
    // Some native deletes can refuse silently. Settle only after clear() verified key removal and ciphertext cleanup.
    if (await SecureStore.getItemAsync(discardKey, options(discardKey)) === '1') {
      await SecureStore.setItemAsync(discardKey, '0', options(discardKey));
      if (await SecureStore.getItemAsync(discardKey, options(discardKey)) === '1') throw new DraftFailure('storage');
    }
  },
  async readBlob(id) { const file = new File(directory(), id); if (file.size > 262_172) throw new DraftFailure('storage'); return file.bytes(); },
  async writeBlob(id, bytes) {
    const dir = directory(); dir.create({ intermediates: true, idempotent: true });
    const file = new File(dir, id); file.create(); file.write(bytes);
  },
  async removeBlobs(except) {
    if (!await SecureStore.isAvailableAsync()) return;
    const dir = directory();
    if (!dir.exists) return;
    if (except) { for (const item of dir.list()) if (item instanceof File && item.name !== except) item.delete(); }
    else { dir.delete(); if (dir.exists) throw new DraftFailure('storage'); }
  },
  async seal(bytes, aad) {
    const encryptionKey = await AESEncryptionKey.generate();
    const sealed = await aesEncryptAsync(bytes, encryptionKey, { additionalData: aad });
    const combined = await sealed.combined('bytes');
    if (typeof combined === 'string') throw new DraftFailure('storage');
    return { bytes: combined, key: await encryptionKey.encoded('hex') };
  },
  async unseal(bytes, encoded, aad) {
    return aesDecryptAsync(AESSealedData.fromCombined(bytes), await AESEncryptionKey.import(encoded, 'hex'), { additionalData: aad });
  },
  newId: randomUUID,
};

const baseUrl = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'https://solventa-web-staging.ja-forerog1.workers.dev';
export const protectedDraftStorage = new EncryptedDraftStorage(baseUrl, custody);
