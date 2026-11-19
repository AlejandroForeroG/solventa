import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { mock } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { AuthSnapshot } from '../apps/mobile/src/features/authentication/domain/session';
import { categories, channels } from '../apps/mobile/src/features/notification-preferences/domain/preferences';
import type { Matrix, Preferences } from '../apps/mobile/src/features/notification-preferences/domain/preferences';
import { messages } from '../apps/mobile/src/shared/i18n/messages';

const mobile = new URL('../apps/mobile/src/', import.meta.url);
const signedIn = (subjectToken = 'first'): AuthSnapshot => ({ status: 'authenticated', principal: { clientId: 'client', subjectToken } });
let auth = signedIn();
let permission = false;
let answerPermission: (granted: boolean) => void;
let permissionRequests = 0;
const reads: string[] = [];
const writes: { owner: string; matrix: Matrix; version: number; key: string }[] = [];
const records = new Map<string, Preferences>();
const emptyMatrix = () => Object.fromEntries(categories.map(category => [category,
  Object.fromEntries(channels.map(channel => [channel, false]))])) as Matrix;
type NativeStyle = CSSProperties | false | undefined | NativeStyle[];
const flatten = (style: NativeStyle): CSSProperties => Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style || {};
type ContainerProps = { children?: ReactNode; style?: NativeStyle; accessibilityElementsHidden?: boolean; importantForAccessibility?: string };
const container = ({ children, style, accessibilityElementsHidden, importantForAccessibility }: ContainerProps) =>
  createElement('div', { style: flatten(style), 'aria-hidden': accessibilityElementsHidden || importantForAccessibility === 'no-hide-descendants' || undefined }, children);

mock.module('react-native', { namedExports: {
  ActivityIndicator: () => createElement('span', { role: 'progressbar' }), ScrollView: container, Text: container, View: container,
  StyleSheet: { create: (styles: unknown) => styles }, useWindowDimensions: () => ({ fontScale: 1 }),
  AppState: { addEventListener: () => ({ remove() {} }) },
  Pressable: ({ children, disabled, onPress, accessibilityLabel, accessibilityRole, accessibilityState, accessibilityValue }: {
    children: ReactNode; disabled?: boolean; onPress: () => void; accessibilityLabel?: string;
    accessibilityRole?: string; accessibilityState?: { checked?: boolean }; accessibilityValue?: { text: string };
  }) => createElement('button', { disabled, onClick: onPress, role: accessibilityRole,
    'aria-label': accessibilityLabel, 'aria-checked': accessibilityState?.checked, 'aria-valuetext': accessibilityValue?.text }, children),
} });
mock.module('react-native-safe-area-context', { namedExports: { SafeAreaView: container } });
mock.module('expo-crypto', { namedExports: { randomUUID } });
mock.module(new URL('theme/index.ts', mobile).href, { namedExports: { theme: { colors: {} } } });
mock.module(new URL('shared/i18n/use-app-messages.ts', mobile).href, { namedExports: { useAppMessages: () => messages.es } });
const execute = () => {};
mock.module(new URL('features/authentication/presentation/AuthenticationProvider.tsx', mobile).href, { namedExports: {
  useAuthentication: () => auth, useAuthenticatedSession: () => ({ baseUrl: 'https://staging.solventa.site', execute }),
} });
mock.module(new URL('features/notification-preferences/adapters/push-permission.ts', mobile).href, { namedExports: {
  pushPermission: async () => permission, openPushSettings: async () => {},
  requestPushPermission: () => {
    permissionRequests++;
    return new Promise<boolean>(resolve => { answerPermission = granted => { permission = granted; resolve(granted); }; });
  },
} });
mock.module(new URL('features/notification-preferences/adapters/preferences-api.ts', mobile).href, { namedExports: {
  PreferencesApiFailure: class extends Error {},
  createPreferencesApi: () => {
    assert.ok(auth.principal);
    const owner = auth.principal.subjectToken;
    return {
      read: async () => { reads.push(owner); return structuredClone(records.get(owner)!); },
      save: async (matrix: Matrix, version: number, key: string) => {
        writes.push({ owner, matrix: structuredClone(matrix), version, key });
        records.set(owner, { version: version + 1, preferences: structuredClone(matrix) });
      },
    };
  },
} });
const imported = await import('../apps/mobile/src/features/notification-preferences/presentation/NotificationPreferencesScreen');
const { NotificationPreferencesScreen } = (imported.default ?? imported) as typeof import('../apps/mobile/src/features/notification-preferences/presentation/NotificationPreferencesScreen');

async function mount() {
  const dom = new JSDOM('<div id="app"></div>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const host = dom.window.document.querySelector('#app')!;
  const root = createRoot(host);
  reads.length = 0; writes.length = 0; permissionRequests = 0; permission = false;
  records.clear();
  for (const owner of ['first', 'second']) records.set(owner, { version: 1, preferences: emptyMatrix() });
  const render = (snapshot: AuthSnapshot) => act(async () => { auth = snapshot; root.render(createElement(NotificationPreferencesScreen)); });
  const control = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const press = async (label: string) => {
    const button = control(label) ?? [...host.querySelectorAll('button')].find(item => item.textContent === label);
    assert.ok(button, label); await act(async () => button.click());
  };
  return { host, render, control, press, close: async () => { await act(async () => root.unmount()); dom.window.close(); } };
}

for (const granted of [true, false]) {
  test(`a ${granted ? 'granted' : 'denied'} push prompt retains unsaved choices behind same-owner session revalidation`, async () => {
    const ui = await mount();
    try {
      await ui.render(signedIn());
      await ui.press('Pagos y primas · Correo');
      await ui.press('Eventos de póliza · Push');
      assert.equal(permissionRequests, 1);
      await ui.render({ status: 'loading' });
      await act(async () => answerPermission(granted));
      assert.equal([...ui.host.querySelectorAll('[role="switch"]')].filter(node => !node.closest('[aria-hidden="true"]')).length, 0);
      assert.equal(writes.length, 0);
      await ui.render(signedIn());
      assert.equal(ui.control('Eventos de póliza · Push')?.getAttribute('aria-checked'), 'true');
      assert.equal(ui.control('Pagos y primas · Correo')?.getAttribute('aria-checked'), 'true');
      assert.deepEqual(reads, ['first']);
      assert.equal(writes.length, 0);
      if (!granted) assert.match(ui.host.textContent!, /Push está elegido, pero no operará/);
      if (!granted) {
        assert.match(ui.host.textContent!, /Push · Sin permiso/);
        assert.match(ui.control('Eventos de póliza · Push')!.getAttribute('aria-valuetext')!, /bloqueado/);
      } else {
        assert.doesNotMatch(ui.host.textContent!, /Push · Sin permiso/);
        assert.equal(ui.control('Eventos de póliza · Push')!.getAttribute('aria-valuetext'), null);
      }
      await ui.press('Guardar preferencias');
      assert.equal(writes.length, 1);
      assert.equal(writes[0].owner, 'first');
      assert.equal(writes[0].version, 1);
      assert.equal(writes[0].matrix.policy.push, true);
      assert.equal(writes[0].matrix.payments.email, true);
      assert.match(writes[0].key, /^[0-9a-f-]{36}$/);
      assert.match(ui.host.textContent!, /Preferencias guardadas/);
    } finally { await ui.close(); }
  });
}

for (const transition of ['second', 'signedOut', 'blocked', 'logoutPending', 'locked', 'authorizing']) {
  test(`a pending permission cannot carry a draft across ${transition}`, async () => {
    const ui = await mount();
    try {
      await ui.render(signedIn());
      await ui.press('Pagos y primas · Correo');
      await ui.press('Eventos de póliza · Push');
      await ui.render({ status: 'loading' });
      await ui.render(transition === 'second' ? signedIn('second') : { status: transition as AuthSnapshot['status'] });
      await act(async () => answerPermission(true));
      if (transition !== 'second') await ui.render(signedIn());
      assert.equal(ui.control('Eventos de póliza · Push')?.getAttribute('aria-checked'), 'false');
      assert.equal(ui.control('Pagos y primas · Correo')?.getAttribute('aria-checked'), 'false');
      assert.equal(writes.length, 0);
    } finally { await ui.close(); }
  });
}

test('an initially unverified session cannot open or read preferences', async () => {
  const ui = await mount();
  try {
    await ui.render({ status: 'loading' });
    assert.equal(ui.control('Eventos de póliza · Push'), null);
    assert.deepEqual(reads, []);
    await ui.render({ status: 'signedOut' });
    assert.deepEqual(reads, []);
  } finally { await ui.close(); }
});
