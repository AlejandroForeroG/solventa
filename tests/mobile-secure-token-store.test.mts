import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const secure = new Map<string, string>();
const calls: Array<{ operation: string; key?: string; protected?: boolean }> = [];
let available = false;
let biometricCapable = false;
let hardware = false;
let enrolled = false;
let level = 0;
let markerExists = false;
let markerValue = '';

mock.module('expo-secure-store', { namedExports: {
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'device-only',
  async getItemAsync(key: string, options: { requireAuthentication?: boolean }) {
    calls.push({ operation: 'read', key, protected: options.requireAuthentication === true });
    return secure.get(key) ?? null;
  },
  async setItemAsync(key: string, value: string, options: { requireAuthentication?: boolean }) {
    calls.push({ operation: 'write', key, protected: options.requireAuthentication === true });
    secure.set(key, value);
  },
  async deleteItemAsync(key: string, options: { requireAuthentication?: boolean }) {
    calls.push({ operation: 'remove', key, protected: options.requireAuthentication === true });
    secure.delete(key);
  },
  async isAvailableAsync() { return available; },
  canUseBiometricAuthentication() { return biometricCapable; },
} });
mock.module('expo-local-authentication', { namedExports: {
  SecurityLevel: { BIOMETRIC_STRONG: 3 },
  async hasHardwareAsync() { return hardware; },
  async isEnrolledAsync() { return enrolled; },
  async getEnrolledLevelAsync() { return level; },
} });
mock.module('expo-crypto', { namedExports: { randomUUID: () => '10000000-0000-4000-8000-000000000001' } });
mock.module('expo-file-system', { namedExports: {
  Paths: { cache: 'cache' },
  File: class {
    get exists() { return markerExists; }
    create() { markerExists = true; }
    write(value: string) { markerValue = value; }
    text() { return markerValue; }
  },
} });
mock.module('expo-localization', { namedExports: { getLocales: () => [{ languageTag: 'es-CO' }] } });

const imported = await import('../apps/mobile/src/features/authentication/adapters/secure-token-store');
const adapter = (imported.default ?? imported) as typeof import('../apps/mobile/src/features/authentication/adapters/secure-token-store');

test('secure storage fails closed without native custody and initializes a reinstall-safe marker', async () => {
  await assert.rejects(adapter.secureTokenStore.read(), (error: unknown) => error instanceof Error && error.message === 'native_required');
  available = true;
  assert.deepEqual(await adapter.secureTokenStore.read(), { version: 1, transaction: null, session: null });
  assert.equal(markerExists, true);
  assert.equal(markerValue, '10000000-0000-4000-8000-000000000001');
  assert.equal(secure.get('solventa.installation.v1'), markerValue);
  assert.ok(calls.some(call => call.operation === 'remove' && call.key === 'solventa.biometric.credentials.v1' && call.protected));
});

test('biometric custody rejects every unavailable capability and uses protected options when available', async () => {
  const expectUnavailable = () => assert.rejects(adapter.biometricVault.unlock(),
    (error: unknown) => error instanceof Error && error.message === 'biometric_unavailable');
  await expectUnavailable();
  biometricCapable = true;
  await expectUnavailable();
  hardware = true;
  await expectUnavailable();
  enrolled = true;
  await expectUnavailable();
  level = 3;
  await assert.rejects(adapter.biometricVault.unlock(), (error: unknown) => error instanceof Error && error.message === 'unauthorized');
  assert.ok(calls.some(call => call.operation === 'read' && call.key === 'solventa.biometric.credentials.v1' && call.protected));
});
