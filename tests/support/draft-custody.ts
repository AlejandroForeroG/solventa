import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { DraftCustody } from '../../apps/mobile/src/features/claim-drafts/adapters/encrypted-draft-storage';

// Only native custody is substituted: AES-GCM is executed and the storage coordinator is the production implementation.
export function draftCustody() {
  const state = { meta: null as string | null, discard: false, installation: randomUUID(), blobs: new Map<string, Uint8Array>(),
    silentWrite: false, refuseRemoval: false, available: true, prompts: 0 };
  const port: DraftCustody = {
    available: async () => state.available,
    authenticate: async () => { state.prompts++; }, installationId: async () => state.installation,
    readMeta: async () => state.meta,
    writeMeta: async value => { if (!state.silentWrite) state.meta = value; },
    removeMeta: async () => { if (!state.refuseRemoval) state.meta = null; },
    readDiscard: async () => state.discard, writeDiscard: async () => { state.discard = true; }, removeDiscard: async () => { state.discard = false; },
    readBlob: async id => { const bytes = state.blobs.get(id); if (!bytes) throw Error('missing encrypted file'); return bytes; },
    writeBlob: async (id, bytes) => { state.blobs.set(id, Uint8Array.from(bytes)); },
    removeBlobs: async except => { for (const id of state.blobs.keys()) if (id !== except) state.blobs.delete(id); },
    async seal(bytes, aad) {
      const key = randomBytes(32), iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return { key: key.toString('hex'), bytes: Buffer.concat([iv, ciphertext, cipher.getAuthTag()]) };
    },
    async unseal(bytes, key, aad) {
      const buffer = Buffer.from(bytes), decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), buffer.subarray(0, 12));
      decipher.setAAD(aad); decipher.setAuthTag(buffer.subarray(-16));
      return Buffer.concat([decipher.update(buffer.subarray(12, -16)), decipher.final()]);
    },
    newId: randomUUID,
  };
  return { state, port };
}
