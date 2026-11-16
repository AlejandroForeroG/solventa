import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

export async function strongBiometricsAvailable(): Promise<boolean> {
  return SecureStore.canUseBiometricAuthentication()
    && await LocalAuthentication.hasHardwareAsync() && await LocalAuthentication.isEnrolledAsync()
    && await LocalAuthentication.getEnrolledLevelAsync() === LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG;
}
