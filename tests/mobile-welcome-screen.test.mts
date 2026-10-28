import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const mobile = new URL('../apps/mobile/src/', import.meta.url);
const Fragment = Symbol('Fragment');
const nodes: Array<{ type: unknown; props: Record<string, unknown> }> = [];
const actions: string[] = [];
const routes: string[] = [];
const Platform = { OS: 'android' };
let auth: Record<string, unknown>;

function createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
  const values = children.flat();
  const normalized = Object.assign({}, props, { children: values.length <= 1 ? values[0] : values });
  if (type === Fragment) return values;
  if (typeof type === 'function') return type(normalized);
  if (type === 'Pressable' && typeof normalized.style === 'function') {
    normalized.style({ pressed: false });
    normalized.style({ pressed: true });
  }
  const node = { type, props: normalized };
  nodes.push(node);
  return node;
}

mock.module('react', { defaultExport: { createElement, Fragment }, namedExports: {} });
mock.module('expo-router', { namedExports: { router: { push: (route: string) => routes.push(route) } } });
mock.module('react-native', { namedExports: {
  ActivityIndicator: 'ActivityIndicator', Platform, Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View',
  StyleSheet: { create: (styles: unknown) => styles },
} });
mock.module('react-native-safe-area-context', { namedExports: { SafeAreaView: 'SafeAreaView' } });
mock.module(new URL('theme/index.ts', mobile).href, { namedExports: {
  theme: { colors: new Proxy({}, { get: (_target, key) => String(key) }) },
} });
mock.module(new URL('features/authentication/presentation/AuthenticationProvider.tsx', mobile).href,
  { namedExports: { useAuthentication: () => auth } });

const copy = {
  headings: { authenticated: 'authenticated', locked: 'locked', blocked: 'blocked', logoutPending: 'logoutPending', signedOut: 'signedOut', signIn: 'signIn' },
  authorizing: 'authorizing', biometricPrompt: 'biometricPrompt', verifying: 'verifying', introduction: 'introduction',
  failures: { unavailable: 'unavailable', biometric_locked: 'biometric_locked' }, reference: 'reference', or: 'or',
  currentAccount: 'currentAccount', biometricEnabled: 'biometricEnabled', biometricSetup: 'biometricSetup',
  biometricReady: 'biometricReady', biometricDescription: 'biometricDescription', primaryRequired: 'primaryRequired',
  pendingLogout: 'pendingLogout', nativeOnly: 'nativeOnly',
  actions: { signIn: 'signIn', unlock: 'unlock', alternative: 'alternative', verifyIdentity: 'verifyIdentity', enable: 'enable', revoke: 'revoke', retry: 'retry', retryLogout: 'retryLogout', signOut: 'signOut', cancel: 'cancel' },
};
mock.module(new URL('shared/i18n/use-app-messages.ts', mobile).href, { namedExports: { useAppMessages: () => copy } });

const imported = await import('../apps/mobile/src/features/welcome/presentation/WelcomeScreen');
const welcome = (imported.default ?? imported) as typeof import('../apps/mobile/src/features/welcome/presentation/WelcomeScreen');

function render(status: string, overrides: Record<string, unknown> = {}) {
  nodes.length = 0;
  actions.length = 0;
  routes.length = 0;
  Platform.OS = 'android';
  auth = {
    status, failure: undefined, traceId: undefined, email: undefined, biometricEnabled: false, canEnableBiometrics: true,
    signIn: () => actions.push('signIn'), signOut: () => actions.push('signOut'), retry: () => actions.push('retry'),
    cancel: () => actions.push('cancel'), enableBiometrics: () => actions.push('enable'), unlock: () => actions.push('unlock'),
    revokeDevice: () => actions.push('revoke'), ...overrides,
  };
  welcome.WelcomeScreen();
  return nodes;
}

function button(label: string) {
  const result = nodes.find(node => node.type === 'Pressable'
    && (node.props.children as { props: { children: unknown } }).props.children === label);
  assert.ok(result, `Missing action: ${label}`);
  return result;
}

function press(label: string) {
  const action = button(label);
  assert.equal(action.props.disabled, false);
  assert.deepEqual(action.props.accessibilityState, { disabled: false });
  (action.props.onPress as () => void)();
}

function textContent(value: unknown): string {
  if (Array.isArray(value)) return value.map(textContent).join('');
  return typeof value === 'string' ? value : '';
}

const text = () => nodes.filter(node => node.type === 'Text').map(node => textContent(node.props.children));
const labels = () => nodes.filter(node => node.type === 'Pressable')
  .map(node => textContent((node.props.children as { props: { children: unknown } }).props.children));

test('signed-out welcome offers primary sign-in without progress or an error', () => {
  render('signedOut');
  assert.ok(text().includes('signedOut'));
  assert.ok(text().includes('introduction'));
  assert.equal(nodes.some(node => node.type === 'ActivityIndicator'), false);
  assert.equal(text().includes('unavailable'), false);
  assert.deepEqual(labels(), ['signIn']);
  press('signIn');
  assert.deepEqual(actions, ['signIn']);
});

for (const [state, message, availableActions] of [
  ['loading', 'verifying', []],
  ['authorizing', 'authorizing', ['cancel']],
  ['biometricPrompt', 'biometricPrompt', []],
] as const) {
  test(`${state} announces progress and exposes only its permitted actions`, () => {
    render(state);
    const progress = nodes.filter(node => node.type === 'ActivityIndicator');
    assert.equal(progress.length, 1);
    assert.equal(progress[0].props.accessibilityLabel, message);
    assert.ok(text().includes(message));
    assert.ok(nodes.some(node => node.type === 'View' && node.props.accessibilityLiveRegion === 'polite'));
    assert.deepEqual(labels(), [...availableActions]);
    if (state === 'authorizing') {
      press('cancel');
      assert.deepEqual(actions, ['cancel']);
    }
  });
}

test('a blocked session displays its error and trace and permits retry or logout', () => {
  render('blocked', { failure: 'unavailable', traceId: 'trace-1' });
  assert.ok(text().includes('blocked'));
  assert.ok(text().includes('unavailable'));
  assert.ok(text().includes('reference: trace-1'));
  assert.equal(nodes.some(node => node.type === 'ActivityIndicator'), false);
  assert.deepEqual(labels(), ['retry', 'signOut']);
  press('retry');
  press('signOut');
  assert.deepEqual(actions, ['retry', 'signOut']);
});

test('a locked session offers biometric unlock and primary authentication as an alternative', () => {
  render('locked');
  assert.ok(text().includes('locked'));
  assert.deepEqual(labels(), ['unlock', 'alternative']);
  press('unlock');
  press('alternative');
  assert.deepEqual(actions, ['unlock', 'signIn']);
  render('biometricPrompt', { failure: 'biometric_locked' });
  assert.equal(text().includes('biometric_locked'), false);
});

test('biometric setup is disabled until primary authentication allows it', () => {
  render('authenticated', { email: 'cliente@example.test', canEnableBiometrics: false });
  assert.ok(text().includes('authenticated'));
  assert.ok(text().includes('cliente@example.test'));
  assert.ok(text().includes('primaryRequired'));
  assert.equal(button('enable').props.disabled, true);
  assert.deepEqual(button('enable').props.accessibilityState, { disabled: true });
  assert.deepEqual(labels(), ['verifyIdentity', 'enable', 'signOut']);
  render('authenticated');
  assert.ok(text().includes('biometricSetup'));
  press('enable');
  assert.deepEqual(actions, ['enable']);
});

test('an enrolled account can revoke biometric access and a pending logout can be retried', () => {
  render('authenticated', { biometricEnabled: true });
  assert.ok(text().includes('biometricEnabled'));
  assert.ok(text().includes('biometricReady'));
  assert.deepEqual(labels(), ['verifyIdentity', 'revoke', 'signOut']);
  press('revoke');
  assert.deepEqual(actions, ['revoke']);
  render('logoutPending');
  assert.ok(text().includes('logoutPending'));
  assert.ok(text().includes('pendingLogout'));
  assert.deepEqual(labels(), ['retryLogout']);
  press('retryLogout');
  assert.deepEqual(actions, ['retry']);
});

test('web explains the native-only flow and disables sign-in', () => {
  render('signedOut');
  nodes.length = 0;
  Platform.OS = 'web';
  welcome.WelcomeScreen();
  assert.ok(text().includes('nativeOnly'));
  assert.equal(button('signIn').props.disabled, true);
  assert.deepEqual(button('signIn').props.accessibilityState, { disabled: true });
  assert.deepEqual(actions, []);
});

test('an authenticated account retains the existing identity-verification entry', () => {
  render('authenticated');
  press('verifyIdentity');
  assert.deepEqual(routes, ['./identity-verification']);
});
