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
  auth = {
    status, failure: undefined, traceId: undefined, email: undefined, biometricEnabled: false, canEnableBiometrics: true,
    signIn: () => actions.push('signIn'), signOut: () => actions.push('signOut'), retry: () => actions.push('retry'),
    cancel: () => actions.push('cancel'), enableBiometrics: () => actions.push('enable'), unlock: () => actions.push('unlock'),
    revokeDevice: () => actions.push('revoke'), ...overrides,
  };
  welcome.WelcomeScreen();
  for (const node of nodes.filter(node => node.type === 'Pressable')) (node.props.onPress as () => void)();
  return nodes;
}

test('welcome screen renders every authentication state and wires every action', () => {
  Platform.OS = 'android';
  render('signedOut');
  render('loading', { failure: 'unavailable', traceId: 'trace-1' });
  render('authorizing');
  render('biometricPrompt', { failure: 'biometric_locked' });
  render('locked');
  render('authenticated', { email: 'cliente@example.test', canEnableBiometrics: false });
  render('authenticated', { biometricEnabled: true });
  render('blocked');
  render('logoutPending');
  Platform.OS = 'web';
  const web = render('signedOut');
  assert.ok(web.some(node => node.type === 'Text' && node.props.children === 'nativeOnly'));
  for (const action of ['signIn', 'unlock', 'enable', 'revoke', 'retry', 'signOut', 'cancel']) assert.ok(actions.includes(action), action);
  assert.ok(routes.includes('./identity-verification'));
});
