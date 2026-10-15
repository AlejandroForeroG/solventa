import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import { randomUUID } from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import { getAppMessages } from '../../../shared/i18n/device-language';

import { AuthFailure } from '../domain/session';
import { createCredentials } from './credentials';

const options = (protectedValue = false): SecureStore.SecureStoreOptions => ({
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
  ...(protectedValue ? { requireAuthentication: true, keychainService: 'solventa.biometric.v1', authenticationPrompt: getAppMessages().securePrompt } : {}),
});

const credentials = createCredentials({
  read: (key, protectedValue) => SecureStore.getItemAsync(key, options(protectedValue)),
  write: (key, value, protectedValue) => SecureStore.setItemAsync(key, value, options(protectedValue)),
  remove: (key, protectedValue) => SecureStore.deleteItemAsync(key, options(protectedValue)),
  async installationId() {
    if (!await SecureStore.isAvailableAsync()) throw new AuthFailure('native_required');
    // Cache is excluded from platform backups. Missing/purged cache fails closed, also on iOS reinstall.
    const marker = new File(Paths.cache, 'solventa-installation-v1');
    if (!marker.exists) { marker.create(); marker.write(randomUUID()); }
    return marker.text();
  },
  async assertBiometrics() {
    if (!SecureStore.canUseBiometricAuthentication()
      || !await LocalAuthentication.hasHardwareAsync() || !await LocalAuthentication.isEnrolledAsync()
      || await LocalAuthentication.getEnrolledLevelAsync() !== LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG) {
      throw new AuthFailure('biometric_unavailable');
    }
  },
});

export const secureTokenStore = credentials.store;
export const biometricVault = credentials.vault;
