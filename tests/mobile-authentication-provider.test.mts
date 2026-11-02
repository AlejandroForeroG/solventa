import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const presentation = new URL('../apps/mobile/src/features/authentication/presentation/', import.meta.url);
const calls: string[] = [];
const effects: Array<() => void | (() => void)> = [];
let currentContext: unknown;
let currentStatus = 'signedOut';
let initialUrl: Promise<string | null> = Promise.resolve(null);
let urlHandler: ((event: { url: string }) => void) | undefined;
let stateHandler: ((state: string) => void) | undefined;
let linkRemoved = false;
let stateRemoved = false;
let constructorOptions: Record<string, unknown> | undefined;

const authentication = {
  complete: async (_url: string) => { calls.push('complete'); },
  restore: async () => { calls.push('restore'); },
  lock: () => { calls.push('lock'); },
  resume: () => { calls.push('resume'); },
  getSnapshot: () => ({ status: currentStatus }),
  subscribe: () => () => {},
  signIn: () => calls.push('signIn'),
  signOut: () => calls.push('signOut'),
  retry: () => calls.push('retry'),
  cancel: () => calls.push('cancel'),
  enableBiometrics: () => calls.push('enableBiometrics'),
  unlock: () => calls.push('unlock'),
  revokeDevice: () => calls.push('revokeDevice'),
};

const React = { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) };
mock.module('react', { defaultExport: React, namedExports: {
  createContext: () => ({ Provider: 'AuthenticationContext' }),
  useContext: () => currentContext,
  useEffect: (effect: () => void | (() => void)) => { effects.push(effect); },
  useState: (factory: () => unknown) => [factory()],
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
} });
mock.module('expo-linking', { namedExports: {
  addEventListener: (_name: string, handler: (event: { url: string }) => void) => {
    urlHandler = handler;
    return { remove: () => { linkRemoved = true; } };
  },
  getInitialURL: () => initialUrl,
} });
mock.module('react-native', { namedExports: { AppState: {
  addEventListener: (_name: string, handler: (state: string) => void) => {
    stateHandler = handler;
    return { remove: () => { stateRemoved = true; } };
  },
} } });
mock.module(new URL('../application/authentication.ts', presentation).href, { namedExports: { Authentication: class {
  constructor(options: Record<string, unknown>) { constructorOptions = options; return authentication; }
} } });
mock.module(new URL('../adapters/auth-browser.ts', presentation).href, { namedExports: { authBrowser: { kind: 'browser' } } });
mock.module(new URL('../adapters/callback.ts', presentation).href, { namedExports: { parseCallback: () => null } });
mock.module(new URL('../adapters/secure-token-store.ts', presentation).href,
  { namedExports: { biometricVault: { kind: 'vault' }, secureTokenStore: { kind: 'store' } } });
mock.module(new URL('../adapters/solventa-session.ts', presentation).href,
  { namedExports: { createSessionApi: (baseUrl: string) => ({ baseUrl }) } });
mock.module(new URL('../adapters/workos.ts', presentation).href, { namedExports: { workosIdentity: { kind: 'identity' } } });

const imported = await import('../apps/mobile/src/features/authentication/presentation/AuthenticationProvider');
const provider = (imported.default ?? imported) as typeof import('../apps/mobile/src/features/authentication/presentation/AuthenticationProvider');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('provider restores, completes callbacks, locks on background and removes native listeners', async () => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test';
  provider.AuthenticationProvider({ children: 'content' });
  assert.equal(constructorOptions?.baseUrl, 'https://api.example.test');
  const cleanup = effects.shift()?.();
  await flush();
  assert.ok(calls.includes('restore'));
  urlHandler?.({ url: 'https://example.test/ignored' });
  urlHandler?.({ url: 'solventa://auth/callback?code=ok' });
  stateHandler?.('background');
  currentStatus = 'signedOut';
  stateHandler?.('active');
  currentStatus = 'authorizing';
  stateHandler?.('active');
  currentStatus = 'biometricPrompt';
  stateHandler?.('active');
  await flush();
  assert.equal(calls.filter(call => call === 'complete').length, 1);
  assert.equal(calls.filter(call => call === 'lock').length, 1);
  assert.equal(calls.filter(call => call === 'resume').length, 3);
  assert.equal(calls.filter(call => call === 'restore').length, 2);
  if (typeof cleanup === 'function') cleanup();
  assert.equal(linkRemoved, true);
  assert.equal(stateRemoved, true);
});

test('provider handles an initial callback, an initial URL failure and disposal before resolution', async () => {
  delete process.env.EXPO_PUBLIC_API_BASE_URL;
  provider.AuthenticationProvider({ children: null });
  assert.equal(constructorOptions?.baseUrl, 'https://solventa-web-staging.ja-forerog1.workers.dev');
  effects.shift();

  initialUrl = Promise.resolve('solventa://auth/callback?code=initial');
  provider.AuthenticationProvider({ children: null });
  effects.shift()?.();
  await flush();
  assert.equal(calls.filter(call => call === 'complete').length, 2);
  initialUrl = Promise.reject(new Error('linking unavailable'));
  provider.AuthenticationProvider({ children: null });
  effects.shift()?.();
  await flush();
  assert.equal(calls.filter(call => call === 'restore').length, 3);
  let resolveUrl!: (value: string | null) => void;
  initialUrl = new Promise(resolve => { resolveUrl = resolve; });
  provider.AuthenticationProvider({ children: null });
  const cleanup = effects.shift()?.();
  if (typeof cleanup === 'function') cleanup();
  resolveUrl('solventa://auth/callback?code=late');
  await flush();
  assert.equal(calls.filter(call => call === 'complete').length, 2);
});

test('authentication hook fails outside the provider and exposes the subscribed operations', () => {
  currentContext = null;
  assert.throws(() => provider.useAuthentication(), /AuthenticationProvider is required/);
  currentContext = authentication;
  currentStatus = 'authenticated';
  const value = provider.useAuthentication();
  assert.equal(value.status, 'authenticated');
  value.signIn(); value.signOut(); value.retry(); value.cancel(); value.enableBiometrics(); value.unlock(); value.revokeDevice();
  assert.ok(calls.includes('revokeDevice'));
});
