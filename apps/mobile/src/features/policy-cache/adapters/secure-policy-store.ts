import * as SecureStore from 'expo-secure-store';

import { installationMarker } from '../../../shared/native/installation-marker';
import { PolicyCacheFailure } from '../domain/cached-policy';
import { ProtectedPolicyCache } from '../application/protected-policy-cache';
import type { ProtectedStore } from '../application/protected-policy-cache';
import { deviceAuthentication, deviceLockAvailable } from './device-authentication';

const key = 'solventa.policies.v1';

// Keystore or Keychain encrypts the value with a key that is readable only while the device is unlocked, on this device only.
// Authentication on each opening is enforced by the cache itself (see ProtectedPolicyCache.unlock), not by the key.
const options = (): SecureStore.SecureStoreOptions => ({
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
  keychainService: key,
});

async function assertNativeProtection() {
  if (!await SecureStore.isAvailableAsync() || !await deviceLockAvailable()) throw new PolicyCacheFailure('unavailable');
}

// Without protection nothing is written: there is no unprotected fallback.
export const securePolicyStore: ProtectedStore = {
  async read() {
    await assertNativeProtection();
    return SecureStore.getItemAsync(key, options());
  },
  async write(value) {
    await assertNativeProtection();
    await SecureStore.setItemAsync(key, value, options());
  },
  async remove() {
    if (!await SecureStore.isAvailableAsync()) return;
    await SecureStore.deleteItemAsync(key, options());
    // The native delete does not report a refused removal on iOS, so a read that is not empty means the data is still there.
    let survivor: string | null;
    try { survivor = await SecureStore.getItemAsync(key, options()); }
    catch { throw new PolicyCacheFailure('not_removed'); }
    if (survivor !== null) throw new PolicyCacheFailure('not_removed');
  },
};

export const protectedPolicyCache = new ProtectedPolicyCache({
  store: securePolicyStore,
  installationId: async () => {
    await assertNativeProtection();
    return installationMarker();
  },
  authentication: deviceAuthentication,
  now: Date.now,
});
