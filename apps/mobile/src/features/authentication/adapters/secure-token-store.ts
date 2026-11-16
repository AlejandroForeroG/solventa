import * as SecureStore from 'expo-secure-store';
import { getAppMessages } from '../../../shared/i18n/device-language';
import { installationMarker } from '../../../shared/native/installation-marker';
import { strongBiometricsAvailable } from '../../../shared/native/strong-biometrics';

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
    return installationMarker();
  },
  async assertBiometrics() {
    if (!await strongBiometricsAvailable()) throw new AuthFailure('biometric_unavailable');
  },
});

export const secureTokenStore = credentials.store;
export const biometricVault = credentials.vault;
