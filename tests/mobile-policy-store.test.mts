import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

type Options = { requireAuthentication?: boolean; keychainService?: string; keychainAccessible?: string };
type Prompt = { promptMessage?: string; biometricsSecurityLevel?: string; disableDeviceFallback?: boolean };
const secure = new Map<string, string>();
const calls: Array<{ operation: string; key: string; options: Options }> = [];
const prompts: Prompt[] = [];
let available = true;
let level = 1;
let authenticationSucceeds = true;
let deleteIgnored = false;
let markerDeleteIgnored = false;
let markerOverwriteFails = false;
let markerValue = '';

mock.module('expo-secure-store', { namedExports: {
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'device-only',
  async getItemAsync(key: string, options: Options) { calls.push({ operation: 'read', key, options }); return secure.get(key) ?? null; },
  async setItemAsync(key: string, value: string, options: Options) {
    calls.push({ operation: 'write', key, options });
    if (markerOverwriteFails && key === 'solventa.policies.discard.v1' && value === '0') throw new Error('write refused');
    secure.set(key, value);
  },
  async deleteItemAsync(key: string, options: Options) { calls.push({ operation: 'remove', key, options }); if (!(key === 'solventa.policies.discard.v1' ? markerDeleteIgnored : deleteIgnored)) secure.delete(key); },
  async isAvailableAsync() { return available; },
} });
mock.module('expo-local-authentication', { namedExports: {
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  async getEnrolledLevelAsync() { return level; },
  async authenticateAsync(options: Prompt) { prompts.push(options); return { success: authenticationSucceeds }; },
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
  policyId: '20000000-0000-4000-8000-000000000001', product: 'vida_hipotecario', premium: '86400.0000', currency: 'COP',
  effectiveFrom: '2026-10-16T02:00:00.000Z', effectiveUntil: '2027-10-16T02:00:00.000Z', coverage: { kind: 'mortgage_life', sumInsured: '320000000.0000' },
};
const failure = (kind: string) => (error: unknown) => error instanceof Error && error.message === kind;

test('the value is stored under its own device-only key and the device authentication, not the key, gates each opening', async () => {
  calls.length = 0; prompts.length = 0;
  await adapter.protectedPolicyCache.save(owner, [source]);
  assert.equal(prompts.length, 0, 'saving never prompts');
  await assert.rejects(adapter.protectedPolicyCache.read(owner), failure('locked'));
  await adapter.protectedPolicyCache.unlock();
  assert.equal((await adapter.protectedPolicyCache.read(owner))?.policies.length, 1);
  assert.deepEqual(prompts, [{ promptMessage: 'Desbloquea para ver tus pólizas', biometricsSecurityLevel: 'strong', disableDeviceFallback: false }]);
  for (const call of calls) {
    assert.ok(call.key.startsWith('solventa.policies.'), 'the cache never touches the credential records');
    assert.equal(call.options.keychainService, call.key);
    assert.equal(call.options.keychainAccessible, 'device-only');
    assert.equal(call.options.requireAuthentication, undefined);
  }
});

test('without a device lock or native custody nothing is written and nothing is read', async () => {
  const cases: Array<[string, () => void, () => void]> = [
    ['no native store', () => { available = false; }, () => { available = true; }],
    ['no device lock', () => { level = 0; }, () => { level = 1; }],
  ];
  for (const [name, degrade, restore] of cases) {
    degrade();
    calls.length = 0; secure.clear();
    await assert.rejects(adapter.protectedPolicyCache.save(owner, [source]), failure('unavailable'), name);
    await assert.rejects(adapter.securePolicyStore.write('value'), failure('unavailable'), name);
    await assert.rejects(adapter.securePolicyStore.read(), failure('unavailable'), name);
    assert.equal(calls.length, 0, `${name}: no storage call`);
    assert.equal(secure.size, 0, `${name}: no unprotected fallback`);
    restore();
  }
  level = 0;
  await assert.rejects(adapter.protectedPolicyCache.unlock(), failure('unavailable'));
  level = 1;
});

test('a cancelled or failed device authentication keeps the cache locked', async () => {
  await adapter.protectedPolicyCache.save(owner, [source]);
  adapter.protectedPolicyCache.lock();
  authenticationSucceeds = false;
  await assert.rejects(adapter.protectedPolicyCache.unlock(), failure('locked'));
  await assert.rejects(adapter.protectedPolicyCache.read(owner), failure('locked'));
  authenticationSucceeds = true;
});

test('removal is verified: a delete the keychain silently refused is reported, never treated as cleared', async () => {
  await adapter.protectedPolicyCache.save(owner, [source]);
  await adapter.protectedPolicyCache.clear();
  assert.equal(secure.has('solventa.policies.v1'), false);

  await adapter.protectedPolicyCache.save(owner, [source]);
  deleteIgnored = true;
  await assert.rejects(adapter.protectedPolicyCache.clear(), failure('not_removed'));
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

test('a removal the keychain refused is recorded in a durable note and finished at the next opening', async () => {
  await adapter.protectedPolicyCache.save(owner, [source]);
  deleteIgnored = true;
  calls.length = 0;
  await assert.rejects(adapter.protectedPolicyCache.clear(), failure('not_removed'));
  assert.equal(secure.has('solventa.policies.discard.v1'), true, 'the owed removal survives a restart');
  assert.ok(calls.filter(call => call.key === 'solventa.policies.discard.v1').every(call => call.options.requireAuthentication === undefined), 'the note is readable before any prompt');

  await adapter.protectedPolicyCache.unlock();
  await assert.rejects(adapter.protectedPolicyCache.readLatest(), failure('not_removed'));
  assert.equal(secure.has('solventa.policies.v1'), true);

  deleteIgnored = false;
  assert.equal(await adapter.protectedPolicyCache.readLatest(), null);
  assert.equal(secure.has('solventa.policies.v1'), false);
  assert.equal(secure.has('solventa.policies.discard.v1'), false);
});

test('without native custody the note does not exist and does not block anything', async () => {
  available = false;
  assert.equal(await adapter.discardMarker.pending(), false);
  available = true;
});

test('a note whose deletion the keychain silently refused is overwritten as settled, and a stuck note fails closed', async () => {
  await adapter.protectedPolicyCache.save(owner, [source]);
  markerDeleteIgnored = true;
  await adapter.protectedPolicyCache.clear();
  assert.equal(secure.has('solventa.policies.v1'), false, 'the copy was removed');
  assert.equal(await adapter.discardMarker.pending(), false, 'the refused deletion no longer leaves a debt');
  await adapter.protectedPolicyCache.save(owner, [source]);
  await adapter.protectedPolicyCache.unlock();
  assert.equal((await adapter.protectedPolicyCache.readLatest())?.snapshot.policies.length, 1, 'a fresh snapshot is not removed by a stale note');

  markerOverwriteFails = true;
  await assert.rejects(adapter.protectedPolicyCache.clear(), failure('not_removed'));
  assert.equal(await adapter.discardMarker.pending(), true, 'when the note cannot be ended either, it stays pending');
  markerDeleteIgnored = false;
  markerOverwriteFails = false;
  await adapter.protectedPolicyCache.clear();
  assert.equal(await adapter.discardMarker.pending(), false);
});
