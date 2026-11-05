import * as SecureStore from 'expo-secure-store';

import { getAppMessages } from '../../../shared/i18n/device-language';
import { installationMarker } from '../../../shared/native/installation-marker';
import { strongBiometricsAvailable } from '../../../shared/native/strong-biometrics';
import { PolicyCacheFailure } from '../domain/cached-policy';
import { ProtectedPolicyCache } from '../application/protected-policy-cache';
import type { ProtectedStore } from '../application/protected-policy-cache';

const key = 'solventa.policies.v1';

// Every read asks for the device biometrics through its own key, so unlocking the phone alone does not release the data.
const options = (): SecureStore.SecureStoreOptions => ({
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
  requireAuthentication: true,
  keychainService: key,
  authenticationPrompt: getAppMessages().policyCachePrompt,
});

async function assertNativeProtection() {
  if (!await SecureStore.isAvailableAsync() || !await strongBiometricsAvailable()) throw new PolicyCacheFailure('unavailable');
}

// Without protection nothing is written: there is no unprotected fallback.
export const securePolicyStore: ProtectedStore = {
  async read() {
    await assertNativeProtection();
    try { return await SecureStore.getItemAsync(key, options()); }
    catch { throw new PolicyCacheFailure('locked'); }
  },
  async write(value) {
    await assertNativeProtection();
    await SecureStore.setItemAsync(key, value, options());
  },
  remove: () => SecureStore.deleteItemAsync(key, options()),
};

export const protectedPolicyCache = new ProtectedPolicyCache({
  store: securePolicyStore,
  installationId: async () => {
    await assertNativeProtection();
    return installationMarker();
  },
  now: Date.now,
});
