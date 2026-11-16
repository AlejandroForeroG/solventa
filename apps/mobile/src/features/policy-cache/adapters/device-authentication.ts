import * as LocalAuthentication from 'expo-local-authentication';

import { getAppMessages } from '../../../shared/i18n/device-language';
import { PolicyCacheFailure } from '../domain/cached-policy';
import type { DeviceAuthentication } from '../application/protected-policy-cache';

// The system prompt accepts a strong biometric or, after failures or by choice, the device code. The app never sees either.
export const deviceAuthentication: DeviceAuthentication = {
  async authenticate() {
    if (await LocalAuthentication.getEnrolledLevelAsync() === LocalAuthentication.SecurityLevel.NONE) throw new PolicyCacheFailure('unavailable');
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: getAppMessages().policyCachePrompt, biometricsSecurityLevel: 'strong', disableDeviceFallback: false,
    });
    if (!result.success) throw new PolicyCacheFailure('locked');
  },
};

// Without a device lock there is nothing to protect the data when the phone is lost, so nothing is stored.
export async function deviceLockAvailable(): Promise<boolean> {
  return await LocalAuthentication.getEnrolledLevelAsync() !== LocalAuthentication.SecurityLevel.NONE;
}
