import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Authentication } from '../apps/mobile/src/features/authentication/application/authentication';
import type { AuthRecord, Configuration } from '../apps/mobile/src/features/authentication/domain/session';
import { AuthFailure, emptyRecord } from '../apps/mobile/src/features/authentication/domain/session';
import { createCredentials } from '../apps/mobile/src/features/authentication/adapters/credentials';
import { parseCallback } from '../apps/mobile/src/features/authentication/adapters/callback';

const baseUrl = 'https://solventa-web-staging.ja-forerog1.workers.dev';
const config: Configuration = { clientId: 'client_synthetic', redirectUri: 'solventa://auth/callback',
  authorizationEndpoint: 'https://api.workos.com/user_management/authorize', tokenEndpoint: 'https://api.workos.com/user_management/authenticate' };
const installationId = '00000000-0000-4000-8000-000000000003';
const principal = { clientId: '00000000-0000-4000-8000-000000000001', subjectToken: '00000000-0000-4000-8000-000000000002' };
const now = 1_800_000_000_000;
const active: AuthRecord = { version: 1, transaction: null, session: { configuration: config, baseUrl,
  phase: 'active', tokens: { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: now + 300_000 } } };

function fixture() {
  const values = new Map<string, string>();
  let currentInstallation = installationId;
  let biometricSuccess = true;
  let available = true;
  let prompts = 0;
  let revoked = false;
  let online = true;
  let currentTime = now;
  let promptDelay = 0;
  let currentPrincipal = principal;
  let browserCancelled = false;
  let exchanges = 0;
  let failPlainRemoval = false;
  let exchangeRejected = false;
  let inspectDelay = async () => {};
  let accessDenied = false;
  let setupFailure: 'configuration' | 'pkce' | 'storage' | undefined;
  let browserOpens = 0;
  const calls: string[] = [];
  const custody = {
    read: async (key: string, protectedValue = false) => {
      if (protectedValue) { prompts++; currentTime += promptDelay; promptDelay = 0; if (!biometricSuccess) throw new Error('synthetic_cancel'); }
      return values.get(key) ?? null;
    },
    write: async (key: string, value: string) => {
      if (setupFailure === 'storage' && key === 'solventa.authentication.v1') {
        setupFailure = undefined;
        throw new Error('synthetic_storage_failure');
      }
      values.set(key, value);
    },
    remove: async (key: string) => {
      if (failPlainRemoval && key === 'solventa.authentication.v1') { failPlainRemoval = false; throw new Error('synthetic_storage_failure'); }
      values.delete(key);
    },
    installationId: async () => currentInstallation,
    assertBiometrics: async () => { if (!available) throw new AuthFailure('biometric_unavailable'); },
  };
  const make = () => {
    const credentials = createCredentials(custody);
    const auth = new Authentication({ baseUrl, ...{ store: credentials.store, biometrics: credentials.vault },
      browser: { assertAvailable: () => {}, open: async () => {
        browserOpens++;
        return browserCancelled ? null : `solventa://auth/callback?state=${'s'.repeat(43)}&code=synthetic-code`;
      } }, now: () => currentTime, parseCallback,
      identity: { authorize: async () => {
        if (setupFailure === 'pkce') { setupFailure = undefined; throw new AuthFailure('unavailable'); }
        return { url: 'https://synthetic.example', state: 's'.repeat(43), codeVerifier: 'v'.repeat(43) };
      },
        exchange: async () => {
          if (exchangeRejected) throw new AuthFailure('unauthorized');
          const tokens = exchanges++ === 0 ? active.session!.tokens : { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: currentTime + 300_000 };
          return { ...tokens, email: currentPrincipal === principal ? 'synthetic@example.test' : 'other@example.test' };
        },
        refresh: async () => ({ accessToken: 'rotated-access', refreshToken: 'rotated-refresh', expiresAt: currentTime + 300_000 }) },
      api: {
        configuration: async () => {
          if (setupFailure === 'configuration') { setupFailure = undefined; throw new AuthFailure('unavailable'); }
          return config;
        },
        register: async () => { revoked = false; return currentPrincipal; },
        inspect: async () => { calls.push('inspect'); await inspectDelay(); if (!online) throw new AuthFailure('unavailable'); if (revoked) throw new AuthFailure('unauthorized'); return currentPrincipal; },
        access: async () => { calls.push('access'); if (accessDenied) throw new AuthFailure('forbidden'); return currentPrincipal; },
        logout: async () => { calls.push('logout'); if (!online) throw new AuthFailure('unavailable'); revoked = true; },
        registerDevice: async () => { calls.push('registerDevice'); if (!online) throw new AuthFailure('unavailable'); },
        inspectDevice: async () => { calls.push('inspectDevice'); if (revoked) throw new AuthFailure('unauthorized'); },
        revokeDevice: async () => { calls.push('revokeDevice'); if (!online) throw new AuthFailure('unavailable'); revoked = true; },
      },
    });
    return { auth, ...credentials };
  };
  async function login(auth: Authentication, _store: ReturnType<typeof make>['store']) {
    await auth.signIn();
  }
  return { make, login, values, calls, prompts: () => prompts,
    cancel: () => { biometricSuccess = false; }, unavailable: () => { available = false; },
    revoke: () => { revoked = true; }, offline: () => { online = false; },
    delayNextPrompt: () => { promptDelay = 250_000; },
    cancelBrowser: () => { browserCancelled = true; }, resumeBrowser: () => { browserCancelled = false; },
    changeAccount: () => { currentPrincipal = { clientId: installationId, subjectToken: installationId }; },
    failRemoval: () => { failPlainRemoval = true; },
    rejectExchange: () => { exchangeRejected = true; },
    failSetup: (step: NonNullable<typeof setupFailure>) => { setupFailure = step; },
    browserOpens: () => browserOpens,
    advance: (ms: number) => { currentTime += ms; },
    forbidAccess: () => { accessDenied = true; },
    pauseInspection: () => {
      const pending = Promise.withResolvers<void>(); const started = Promise.withResolvers<void>();
      inspectDelay = () => { started.resolve(); return pending.promise; };
      return { started: started.promise, release: () => { inspectDelay = async () => {}; pending.resolve(); } };
    },
    reinstall: () => { currentInstallation = '00000000-0000-4000-8000-000000000004'; } };
}

test('activation requires primary login; confirmation and registration migrate credentials without a non-biometric fallback', async () => {
  const f = fixture();
  const { auth, store } = f.make();
  await auth.restore();
  await auth.enableBiometrics();
  assert.equal(auth.getSnapshot().failure, 'unauthorized');
  assert.equal(f.calls.length, 0);
  await f.login(auth, store);
  await auth.enableBiometrics();
  assert.equal(auth.getSnapshot().biometricEnabled, true);
  assert.equal(f.prompts(), 1);
  assert.equal(f.calls.includes('registerDevice'), true);
  assert.equal(f.values.has('solventa.authentication.v1'), false);
  assert.equal(f.values.has('solventa.biometric.credentials.v1'), true);
});

test('startup and retries never prompt or bypass biometrics; explicit unlock validates session, permission and device', async () => {
  const f = fixture(); const first = f.make();
  await f.login(first.auth, first.store); await first.auth.enableBiometrics();
  const restored = f.make(); const prompts = f.prompts();
  await restored.auth.restore(); await restored.auth.retry();
  assert.equal(restored.auth.getSnapshot().status, 'locked');
  assert.equal(restored.auth.getSnapshot().email, undefined);
  assert.equal(f.prompts(), prompts);
  f.calls.length = 0;
  await restored.auth.unlock();
  assert.equal(restored.auth.getSnapshot().status, 'authenticated');
  assert.equal(restored.auth.getSnapshot().email, 'synthetic@example.test');
  assert.deepEqual(f.calls, ['inspect', 'access', 'inspectDevice']);
  const unlockedPrompts = f.prompts();
  restored.auth.lock(); restored.auth.resume(); await restored.auth.restore();
  assert.equal(restored.auth.getSnapshot().status, 'authenticated');
  assert.equal(f.prompts(), unlockedPrompts);
});

test('warm background returns revalidate silently without a biometric prompt, while cold launch stays locked', async () => {
  const f = fixture(); const flow = f.make();
  await f.login(flow.auth, flow.store); await flow.auth.enableBiometrics();
  const prompts = f.prompts();
  for (let attempt = 0; attempt < 3; attempt++) {
    f.calls.length = 0; flow.auth.lock(); flow.auth.lock();
    assert.equal(flow.auth.getSnapshot().status, 'loading');
    assert.equal(flow.auth.getSnapshot().principal, undefined);
    assert.equal(flow.auth.getSnapshot().email, undefined);
    assert.deepEqual(f.calls, []);
    flow.auth.resume(); await flow.auth.restore();
    assert.equal(flow.auth.getSnapshot().status, 'authenticated');
    assert.equal(flow.auth.getSnapshot().biometricEnabled, true);
    assert.deepEqual(f.calls, ['inspect', 'access', 'inspectDevice']);
    assert.equal(f.prompts(), prompts);
    assert.equal(f.values.has('solventa.authentication.v1'), false);
  }
  const cold = f.make(); f.calls.length = 0; await cold.auth.restore();
  assert.equal(cold.auth.getSnapshot().status, 'locked');
  assert.equal(f.prompts(), prompts);
  assert.deepEqual(f.calls, []);
  await cold.auth.unlock();
  assert.equal(cold.auth.getSnapshot().status, 'authenticated');
  assert.equal(f.prompts(), prompts + 1);
});

test('warm return never grants cached access after server revocation or a permission denial', async () => {
  for (const revoked of [true, false]) {
    const f = fixture(); const flow = f.make();
    await f.login(flow.auth, flow.store); await flow.auth.enableBiometrics();
    const prompts = f.prompts(); flow.auth.lock();
    if (revoked) f.revoke(); else f.forbidAccess();
    flow.auth.resume(); await flow.auth.restore();
    assert.equal(flow.auth.getSnapshot().status, revoked ? 'signedOut' : 'blocked');
    assert.equal(flow.auth.getSnapshot().principal, undefined);
    assert.equal(flow.auth.getSnapshot().email, undefined);
    assert.equal(f.prompts(), prompts);
    if (revoked) assert.equal(await flow.vault.info(), null);
  }
});

test('a warm credential needing renewal waits for explicit biometric entry rather than silently prompting', async () => {
  const f = fixture(); const flow = f.make();
  await f.login(flow.auth, flow.store); await flow.auth.enableBiometrics();
  const prompts = f.prompts(); flow.auth.lock(); f.advance(300_000);
  flow.auth.resume(); f.calls.length = 0; await flow.auth.restore();
  assert.equal(flow.auth.getSnapshot().status, 'locked');
  assert.equal(f.prompts(), prompts);
  assert.deepEqual(f.calls, []);
  await flow.auth.unlock();
  assert.equal(flow.auth.getSnapshot().status, 'authenticated');
  assert.equal(f.prompts(), prompts + 1);
  assert.equal((await flow.vault.unlock()).session?.tokens.accessToken, 'rotated-access');
});

test('rapid background transitions invalidate stale checks without discarding an already-unlocked warm session', async () => {
  const f = fixture(); const flow = f.make();
  await f.login(flow.auth, flow.store); await flow.auth.enableBiometrics();
  const prompts = f.prompts(); const gate = f.pauseInspection();
  flow.auth.lock(); flow.auth.resume();
  const first = flow.auth.restore(); await gate.started;
  flow.auth.lock(); flow.auth.lock(); flow.auth.resume();
  const second = flow.auth.restore(); gate.release(); await Promise.all([first, second]);
  assert.equal(flow.auth.getSnapshot().status, 'authenticated');
  assert.equal(flow.auth.getSnapshot().biometricEnabled, true);
  assert.equal(f.prompts(), prompts);
});

test('cancellation grants no entry and makes no protected network call', async () => {
  const f = fixture(); const flow = f.make();
  await f.login(flow.auth, flow.store); await flow.auth.enableBiometrics();
  flow.auth.lock(); flow.auth.resume(); f.cancel(); f.calls.length = 0;
  await flow.auth.unlock();
  assert.equal(flow.auth.getSnapshot().status, 'locked');
  assert.equal(flow.auth.getSnapshot().failure, 'biometric_failed');
  assert.deepEqual(f.calls, []);
});

test('unavailable hardware and cancelled activation never register or enable a device', async () => {
  for (const unavailable of [true, false]) {
    const f = fixture(); const flow = f.make(); await f.login(flow.auth, flow.store);
    if (unavailable) f.unavailable(); else f.cancel();
    f.calls.length = 0; await flow.auth.enableBiometrics();
    assert.notEqual(flow.auth.getSnapshot().status, 'authenticated');
    assert.equal(f.calls.includes('registerDevice'), false);
    assert.equal(await flow.vault.info(), null);
    if (!unavailable) {
      await flow.auth.signIn();
      assert.equal(flow.auth.getSnapshot().status, 'authenticated');
      assert.equal(flow.auth.getSnapshot().biometricEnabled, false);
    }
  }
});

test('revoked sessions require primary login and erase biometric credentials; offline never grants entry', async () => {
  for (const revoke of [true, false]) {
    const f = fixture(); const flow = f.make(); await f.login(flow.auth, flow.store); await flow.auth.enableBiometrics();
    flow.auth.lock(); flow.auth.resume(); if (revoke) f.revoke(); else f.offline();
    await flow.auth.unlock();
    assert.notEqual(flow.auth.getSnapshot().status, 'authenticated');
    assert.equal(Boolean(await flow.vault.info()), !revoke);
  }
});

test('offline logout disables biometrics and only retains encrypted revocation intent after restart', async () => {
  const f = fixture(); const flow = f.make(); await f.login(flow.auth, flow.store); await flow.auth.enableBiometrics();
  f.offline(); await flow.auth.signOut();
  assert.equal(flow.auth.getSnapshot().status, 'logoutPending');
  assert.equal(await flow.vault.info(), null);
  assert.equal(f.values.has('solventa.biometric.credentials.v1'), false);
  const restored = f.make(); f.calls.length = 0; await restored.auth.restore();
  assert.equal(restored.auth.getSnapshot().status, 'logoutPending');
  assert.deepEqual(f.calls, ['logout']);
});

test('reinstall invalidates surviving keychain records and does not recover primary or biometric access', async () => {
  const f = fixture(); const flow = f.make(); await f.login(flow.auth, flow.store); await flow.auth.enableBiometrics();
  f.reinstall(); const restored = f.make(); await restored.auth.restore();
  assert.equal(restored.auth.getSnapshot().status, 'signedOut');
  assert.equal(await restored.vault.info(), null);
  assert.deepEqual(await restored.store.read(), emptyRecord());
});

test('restored primary sessions cannot enable biometrics without a new primary login', async () => {
  const f = fixture(); const flow = f.make(); await flow.store.write(active); await flow.auth.restore();
  await flow.auth.enableBiometrics();
  assert.equal(flow.auth.getSnapshot().failure, 'unauthorized');
  assert.equal(f.calls.includes('registerDevice'), false);
});

test('backgrounding preserves primary-login eligibility after server revalidation without enabling restored sessions', async () => {
  const f = fixture(); const flow = f.make();
  await f.login(flow.auth, flow.store);
  assert.equal(flow.auth.getSnapshot().canEnableBiometrics, true);
  for (let attempt = 0; attempt < 2; attempt++) {
    flow.auth.lock();
    assert.notEqual(flow.auth.getSnapshot().status, 'authenticated');
    assert.equal(flow.auth.getSnapshot().email, undefined);
    flow.auth.resume(); f.calls.length = 0; await flow.auth.restore();
    assert.deepEqual(f.calls, ['inspect', 'access']);
    assert.equal(flow.auth.getSnapshot().canEnableBiometrics, true);
  }
  const restarted = f.make(); await restarted.auth.restore();
  assert.equal(restarted.auth.getSnapshot().canEnableBiometrics, false);
  await flow.auth.enableBiometrics();
  assert.equal(flow.auth.getSnapshot().biometricEnabled, true);
});

test('a revoked primary session after background cannot preserve activation eligibility or register a device', async () => {
  const f = fixture(); const flow = f.make(); await f.login(flow.auth, flow.store);
  flow.auth.lock(); flow.auth.resume(); f.revoke(); f.calls.length = 0;
  await flow.auth.restore();
  assert.equal(flow.auth.getSnapshot().status, 'signedOut');
  assert.notEqual(flow.auth.getSnapshot().canEnableBiometrics, true);
  await flow.auth.enableBiometrics();
  assert.equal(f.calls.includes('registerDevice'), false);
  assert.equal(await flow.vault.info(), null);
});

test('the unchanged public configuration allows activation after a primary login', async () => {
  const f = fixture(); const flow = f.make(); await f.login(flow.auth, flow.store);
  assert.equal(flow.auth.getSnapshot().canEnableBiometrics, true);
  await flow.auth.enableBiometrics();
  assert.equal(flow.auth.getSnapshot().biometricEnabled, true);
  assert.equal(f.prompts(), 1);
  assert.equal(f.calls.includes('registerDevice'), true);
});

test('device revocation calls its own endpoint and offline retries preserve that intent across restart', async () => {
  for (const offline of [true, false]) {
    const f = fixture(); const flow = f.make(); await f.login(flow.auth, flow.store); await flow.auth.enableBiometrics();
    f.calls.length = 0; if (offline) f.offline(); await flow.auth.revokeDevice();
    assert.equal(await flow.vault.info(), null);
    assert.deepEqual(f.calls, ['revokeDevice']);
    assert.equal(flow.auth.getSnapshot().status, offline ? 'logoutPending' : 'signedOut');
    if (offline) {
      const restored = f.make(); f.calls.length = 0; await restored.auth.restore();
      assert.deepEqual(f.calls, ['revokeDevice']);
      assert.equal(restored.auth.getSnapshot().status, 'logoutPending');
    }
  }
});

test('activation persists the rotated token pair when biometric confirmation crosses the refresh threshold', async () => {
  const f = fixture(); const flow = f.make(); await f.login(flow.auth, flow.store);
  f.delayNextPrompt(); await flow.auth.enableBiometrics();
  assert.equal(flow.auth.getSnapshot().biometricEnabled, true);
  const record = await flow.vault.unlock();
  assert.equal(record.session?.tokens.accessToken, 'rotated-access');
  assert.equal(record.session?.tokens.refreshToken, 'rotated-refresh');
  assert.equal(f.values.has('solventa.authentication.v1'), false);
});

test('backgrounding a failed biometric connection drops unlocked memory and cannot reconnect without another prompt', async () => {
  const f = fixture(); const flow = f.make(); await f.login(flow.auth, flow.store); await flow.auth.enableBiometrics();
  flow.auth.lock(); flow.auth.resume(); f.offline(); await flow.auth.unlock();
  assert.equal(flow.auth.getSnapshot().status, 'blocked');
  const prompts = f.prompts(); flow.auth.lock(); flow.auth.resume(); await flow.auth.retry();
  assert.equal(flow.auth.getSnapshot().status, 'locked');
  assert.equal(f.prompts(), prompts);
});

test('alternative WorkOS login preserves same-account preference and protects the new session without revoking', async () => {
  const f = fixture(); const flow = f.make();
  await f.login(flow.auth, flow.store); await flow.auth.enableBiometrics();
  flow.auth.lock(); flow.auth.resume(); f.calls.length = 0;
  const prompts = f.prompts();
  await flow.auth.signIn();
  assert.equal(flow.auth.getSnapshot().biometricEnabled, true);
  assert.equal(f.prompts(), prompts + 1);
  assert.equal(f.calls.includes('registerDevice'), true);
  assert.equal(f.calls.includes('logout') || f.calls.includes('revokeDevice'), false);
  assert.equal(f.values.has('solventa.authentication.v1'), false);
  assert.equal((await flow.vault.unlock()).session?.tokens.accessToken, 'new-access');
  const restarted = f.make(); await restarted.auth.restore();
  assert.equal(restarted.auth.getSnapshot().status, 'locked');
  await restarted.auth.unlock();
  assert.equal(restarted.auth.getSnapshot().status, 'authenticated');
});

test('cancelling the alternative browser restores locked biometric entry across restart without granting access', async () => {
  const f = fixture(); const flow = f.make();
  await f.login(flow.auth, flow.store); await flow.auth.enableBiometrics();
  flow.auth.lock(); flow.auth.resume(); f.cancelBrowser(); f.calls.length = 0;
  const prompts = f.prompts(); await flow.auth.signIn();
  assert.equal(flow.auth.getSnapshot().status, 'locked');
  assert.equal(flow.auth.getSnapshot().failure, undefined);
  assert.equal(flow.auth.getSnapshot().traceId, undefined);
  assert.equal(f.prompts(), prompts);
  assert.equal(f.values.has('solventa.biometric.credentials.v1'), true);
  assert.deepEqual((await flow.vault.info())?.owner, principal);
  assert.equal((await flow.vault.info())?.suspended, false);
  const restarted = f.make(); await restarted.auth.restore();
  assert.equal(restarted.auth.getSnapshot().status, 'locked');
  assert.deepEqual(f.calls, []);
  f.resumeBrowser(); await restarted.auth.signIn();
  assert.equal(restarted.auth.getSnapshot().biometricEnabled, true);
});

test('alternative login setup failures restore biometric entry without opening the browser or granting access', async () => {
  for (const step of ['configuration', 'pkce', 'storage'] as const) {
    const f = fixture(); const flow = f.make();
    await f.login(flow.auth, flow.store); await flow.auth.enableBiometrics();
    flow.auth.lock(); flow.auth.resume(); f.calls.length = 0;
    const prompts = f.prompts(); const opened = f.browserOpens();
    f.failSetup(step); await flow.auth.signIn();
    assert.equal(flow.auth.getSnapshot().status, 'locked', step);
    assert.equal(flow.auth.getSnapshot().failure, 'unavailable', step);
    assert.equal((await flow.vault.info())?.suspended, false, step);
    assert.equal(f.values.has('solventa.authentication.v1'), false, step);
    assert.equal(f.browserOpens(), opened, step);
    assert.equal(f.prompts(), prompts, step);
    assert.deepEqual(f.calls, [], step);
    await flow.auth.unlock();
    assert.equal(flow.auth.getSnapshot().status, 'authenticated', step);
    assert.deepEqual(f.calls, ['inspect', 'access', 'inspectDevice'], step);
    assert.equal(f.prompts(), prompts + 1, step);
    await flow.auth.signIn();
    assert.equal(f.browserOpens(), opened + 1, step);
    assert.equal(flow.auth.getSnapshot().status, 'authenticated', step);
  }
});

test('another WorkOS account never inherits the previous biometric preference or binding', async () => {
  const f = fixture(); const flow = f.make();
  await f.login(flow.auth, flow.store); await flow.auth.enableBiometrics();
  flow.auth.lock(); flow.auth.resume(); f.changeAccount(); f.calls.length = 0;
  const prompts = f.prompts(); await flow.auth.signIn();
  assert.equal(flow.auth.getSnapshot().status, 'authenticated');
  assert.equal(flow.auth.getSnapshot().biometricEnabled, false);
  assert.equal(flow.auth.getSnapshot().email, 'other@example.test');
  assert.equal(f.prompts(), prompts);
  assert.equal(await flow.vault.info(), null);
  assert.equal(f.calls.includes('registerDevice'), false);
  const restarted = f.make(); await restarted.auth.restore();
  assert.equal(restarted.auth.getSnapshot().biometricEnabled, false);
});

test('explicit logout and device revocation erase preference and do not auto-enable after a new primary login', async () => {
  for (const action of ['signOut', 'revokeDevice'] as const) {
    const f = fixture(); const flow = f.make();
    await f.login(flow.auth, flow.store); await flow.auth.enableBiometrics();
    await flow.auth[action]();
    assert.equal(await flow.vault.info(), null);
    assert.equal(f.values.has('solventa.biometric.credentials.v1'), false);
    assert.equal(flow.auth.getSnapshot().status, 'signedOut');
    f.calls.length = 0; await flow.auth.signIn();
    assert.equal(flow.auth.getSnapshot().biometricEnabled, false);
    assert.equal(f.calls.includes('registerDevice'), false);
  }
  const f = fixture(); const flow = f.make();
  await f.login(flow.auth, flow.store); await flow.auth.enableBiometrics();
  flow.auth.lock(); flow.auth.resume(); f.cancelBrowser(); await flow.auth.signIn();
  await flow.auth.unlock();
  await flow.auth.signOut();
  assert.equal(await flow.vault.info(), null);
  f.resumeBrowser(); f.calls.length = 0; await flow.auth.signIn();
  assert.equal(flow.auth.getSnapshot().biometricEnabled, false);
  assert.equal(f.calls.includes('registerDevice'), false);
});

test('legacy activation learns its owner only after biometric unlock and successful server checks', async () => {
  const f = fixture(); const flow = f.make();
  await f.login(flow.auth, flow.store); await flow.auth.enableBiometrics();
  f.values.set('solventa.biometric.binding.v1', JSON.stringify({ installationId, baseUrl }));
  const restarted = f.make(); await restarted.auth.restore();
  assert.equal((await restarted.vault.info())?.owner, undefined);
  await restarted.auth.unlock();
  assert.deepEqual((await restarted.vault.info())?.owner, principal);
  restarted.auth.lock(); restarted.auth.resume(); await restarted.auth.signIn();
  assert.equal(restarted.auth.getSnapshot().biometricEnabled, true);
});

test('cancelling WorkOS preserves legacy biometric entry even before its owner metadata has been upgraded', async () => {
  const f = fixture(); const flow = f.make();
  await f.login(flow.auth, flow.store); await flow.auth.enableBiometrics();
  f.values.set('solventa.biometric.binding.v1', JSON.stringify({ installationId, baseUrl }));
  const restarted = f.make(); await restarted.auth.restore();
  f.cancelBrowser(); f.calls.length = 0;
  const prompts = f.prompts(); await restarted.auth.signIn();
  assert.equal(restarted.auth.getSnapshot().status, 'locked');
  assert.equal(restarted.auth.getSnapshot().failure, undefined);
  assert.equal(restarted.auth.getSnapshot().traceId, undefined);
  assert.equal(f.prompts(), prompts);
  assert.equal(f.values.has('solventa.biometric.credentials.v1'), true);
  assert.deepEqual(f.calls, []);
  const reopened = f.make(); await reopened.auth.restore();
  assert.equal(reopened.auth.getSnapshot().status, 'locked');
  await reopened.auth.unlock();
  assert.equal(reopened.auth.getSnapshot().status, 'authenticated');
  assert.deepEqual(f.calls, ['inspect', 'access', 'inspectDevice']);
});

test('an ownerless legacy preference never enables biometrics for a new WorkOS account', async () => {
  const f = fixture(); const flow = f.make();
  await f.login(flow.auth, flow.store); await flow.auth.enableBiometrics();
  f.values.set('solventa.biometric.binding.v1', JSON.stringify({ installationId, baseUrl }));
  const restarted = f.make(); await restarted.auth.restore();
  f.changeAccount(); f.calls.length = 0; await restarted.auth.signIn();
  assert.equal(restarted.auth.getSnapshot().status, 'authenticated');
  assert.equal(restarted.auth.getSnapshot().biometricEnabled, false);
  assert.equal(await restarted.vault.info(), null);
  assert.equal(f.values.has('solventa.biometric.credentials.v1'), false);
  assert.equal(f.calls.includes('registerDevice'), false);
});

test('cancelling a legacy alternative login cannot bypass subsequent server revocation', async () => {
  const f = fixture(); const flow = f.make();
  await f.login(flow.auth, flow.store); await flow.auth.enableBiometrics();
  f.values.set('solventa.biometric.binding.v1', JSON.stringify({ installationId, baseUrl }));
  const restarted = f.make(); await restarted.auth.restore();
  f.cancelBrowser(); await restarted.auth.signIn(); f.revoke(); f.calls.length = 0;
  await restarted.auth.unlock();
  assert.equal(restarted.auth.getSnapshot().status, 'signedOut');
  assert.equal(await restarted.vault.info(), null);
  assert.deepEqual(f.calls, ['inspect']);
});

test('failed plain-record removal after suspending a binding cannot unlock or restore the old session', async () => {
  const f = fixture(); const flow = f.make();
  await f.login(flow.auth, flow.store); await flow.auth.enableBiometrics();
  flow.auth.lock(); flow.auth.resume(); f.failRemoval(); await flow.auth.signIn();
  assert.notEqual(flow.auth.getSnapshot().status, 'authenticated');
  assert.equal((await flow.vault.info())?.suspended, true);
  await assert.rejects(flow.vault.unlock(), error => error instanceof AuthFailure && error.kind === 'unauthorized');
  const restarted = f.make(); await restarted.auth.restore();
  assert.notEqual(restarted.auth.getSnapshot().status, 'authenticated');
});

test('a denied alternative code exchange returns to locked entry and rechecks the old session before access', async () => {
  const f = fixture(); const flow = f.make();
  await f.login(flow.auth, flow.store); await flow.auth.enableBiometrics();
  flow.auth.lock(); flow.auth.resume(); f.rejectExchange(); f.calls.length = 0;
  await flow.auth.signIn();
  assert.equal(flow.auth.getSnapshot().status, 'locked');
  assert.deepEqual(f.calls, []);
  await flow.auth.unlock();
  assert.equal(flow.auth.getSnapshot().status, 'authenticated');
  assert.deepEqual(f.calls, ['inspect', 'access', 'inspectDevice']);
});
