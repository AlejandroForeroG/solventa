import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

type Options = { requireAuthentication?: boolean; keychainService?: string; keychainAccessible?: string; authenticationPrompt?: string };
const secure = new Map<string, string>();
const calls: Array<{ operation: string; key: string; options: Options }> = [];
let available = true;
let biometricCapable = true;
let hardware = true;
let enrolled = true;
let level = 3;
let readFails = false;
let deleteIgnored = false;
let markerValue = '';

mock.module('expo-secure-store', { namedExports: {
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'device-only',
  async getItemAsync(key: string, options: Options) {
    calls.push({ operation: 'read', key, options });
    if (readFails) throw new Error('authentication canceled');
    return secure.get(key) ?? null;
  },
  async setItemAsync(key: string, value: string, options: Options) { calls.push({ operation: 'write', key, options }); secure.set(key, value); },
  async deleteItemAsync(key: string, options: Options) { calls.push({ operation: 'remove', key, options }); if (!deleteIgnored) secure.delete(key); },
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
    get exists() { return markerValue !== ''; }
    create() {}
    write(value: string) { markerValue = value; }
    text() { return markerValue; }
  },
} });
mock.module('expo-localization', { namedExports: { getLocales: () => [{ languageTag: 'es-CO' }] } });

const imported = await import('../apps/mobile/src/features/policy-cache/adapters/secure-policy-store');
const adapter = (imported.default ?? imported) as typeof import('../apps/mobile/src/features/policy-cache/adapters/secure-policy-store');

const owner = { clientId: '00000000-0000-4000-8000-000000000001', subjectToken: '00000000-0000-4000-8000-000000000002' };
const source = {
  policyId: '20000000-0000-4000-8000-000000000001', status: 'issued', premium: '1250000.0000', currency: 'COP',
  effectiveFrom: '2026-11-01T00:00:00.000Z', effectiveUntil: '2027-11-01T00:00:00.000Z',
};

test('every read and write requires device authentication with its own key and device-only passcode custody', async () => {
  calls.length = 0;
  await adapter.protectedPolicyCache.save(owner, [source]);
  assert.equal((await adapter.protectedPolicyCache.read(owner))?.policies.length, 1);
  const touched = calls.filter(call => call.key === 'solventa.policies.v1');
  assert.deepEqual(touched.map(call => call.operation), ['write', 'read']);
  for (const call of touched) {
    assert.equal(call.options.requireAuthentication, true);
    assert.equal(call.options.keychainService, 'solventa.policies.v1');
    assert.equal(call.options.keychainAccessible, 'device-only');
    assert.equal(call.options.authenticationPrompt, 'Confirma tu identidad para ver tus pólizas');
  }
  assert.ok(calls.every(call => call.key === 'solventa.policies.v1'), 'the cache never touches the credential records');
});

test('without strong biometrics or native custody nothing is written and nothing is read', async () => {
  const cases: Array<[string, () => void, () => void]> = [
    ['no native store', () => { available = false; }, () => { available = true; }],
    ['no biometric capability', () => { biometricCapable = false; }, () => { biometricCapable = true; }],
    ['no hardware', () => { hardware = false; }, () => { hardware = true; }],
    ['not enrolled', () => { enrolled = false; }, () => { enrolled = true; }],
    ['weak enrollment', () => { level = 2; }, () => { level = 3; }],
  ];
  for (const [name, degrade, restore] of cases) {
    degrade();
    calls.length = 0;
    secure.clear();
    await assert.rejects(adapter.protectedPolicyCache.save(owner, [source]), (error: unknown) => error instanceof Error && error.message === 'unavailable', name);
    await assert.rejects(adapter.protectedPolicyCache.read(owner), (error: unknown) => error instanceof Error && error.message === 'unavailable', name);
    assert.equal(calls.length, 0, `${name}: no storage call`);
    await assert.rejects(adapter.securePolicyStore.write('value'), (error: unknown) => error instanceof Error && error.message === 'unavailable', name);
    await assert.rejects(adapter.securePolicyStore.read(), (error: unknown) => error instanceof Error && error.message === 'unavailable', name);
    assert.equal(calls.length, 0, `${name}: the store itself refuses direct access`);
    assert.equal(secure.size, 0, `${name}: no unprotected fallback`);
    restore();
  }
});

test('cancelled or failed device authentication releases nothing', async () => {
  await adapter.protectedPolicyCache.save(owner, [source]);
  readFails = true;
  await assert.rejects(adapter.protectedPolicyCache.read(owner), (error: unknown) => error instanceof Error && error.message === 'locked');
  readFails = false;
});

test('removal is verified: a delete the keychain silently refused is reported, never treated as cleared', async () => {
  await adapter.protectedPolicyCache.save(owner, [source]);
  await adapter.protectedPolicyCache.clear();
  assert.equal(secure.has('solventa.policies.v1'), false);

  await adapter.protectedPolicyCache.save(owner, [source]);
  deleteIgnored = true;
  await assert.rejects(adapter.protectedPolicyCache.clear(), (error: unknown) => error instanceof Error && error.message === 'not_removed');
  readFails = true;
  await assert.rejects(adapter.protectedPolicyCache.clear(), (error: unknown) => error instanceof Error && error.message === 'not_removed');
  readFails = false;
  deleteIgnored = false;
  await adapter.protectedPolicyCache.clear();
  assert.equal(secure.has('solventa.policies.v1'), false);
});

test('clearing without native custody has nothing to remove and does not fail sign-out', async () => {
  available = false;
  calls.length = 0;
  await adapter.protectedPolicyCache.clear();
  assert.equal(calls.length, 0);
  available = true;
});
