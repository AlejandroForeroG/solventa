import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { AuthSnapshot } from '../apps/mobile/src/features/authentication/domain/session';
import { messages } from '../apps/mobile/src/shared/i18n/messages';

const mobile = new URL('../apps/mobile/src/', import.meta.url);
const coordinates = { latitude: 4.648, longitude: -74.098 };
const signedIn = (clientId: string): AuthSnapshot => ({ status: 'authenticated', principal: { clientId, subjectToken: 'subject' } });
const calls: unknown[] = [];
let auth = signedIn('first');
let answerPermission: (granted: boolean) => void;
const container = ({ children }: { children: ReactNode }) => createElement('div', null, children);

mock.module('react-native', { namedExports: {
  ActivityIndicator: () => null, ScrollView: container, Text: container, View: container,
  TextInput: () => createElement('input'), StyleSheet: { create: (styles: unknown) => styles },
  Pressable: ({ children, disabled, onPress }: { children: ReactNode; disabled: boolean; onPress: () => void }) =>
    createElement('button', { disabled, onClick: onPress }, children),
} });
mock.module('react-native-safe-area-context', { namedExports: { SafeAreaView: container } });
mock.module(new URL('theme/index.ts', mobile).href, { namedExports: { theme: { colors: {} } } });
mock.module(new URL('shared/i18n/use-app-messages.ts', mobile).href, { namedExports: { useAppMessages: () => messages.es } });
const execute = () => {};
mock.module(new URL('features/authentication/presentation/AuthenticationProvider.tsx', mobile).href, { namedExports: {
  useAuthentication: () => auth, useAuthenticatedSession: () => ({ baseUrl: 'https://example.test', execute }),
} });
mock.module(new URL('features/assistance/adapters/device-location.ts', mobile).href, { namedExports: {
  requestDeviceLocationPermission: () => {
    calls.push('permission');
    return new Promise<boolean>(resolve => { answerPermission = resolve; });
  },
  readDeviceLocation: async () => { calls.push('location'); return coordinates; },
} });
mock.module(new URL('features/assistance/adapters/assistance-api.ts', mobile).href, { namedExports: {
  createAssistanceApi: () => ({ search: async (request: unknown) => { calls.push(request); return []; } }),
} });

const imported = await import('../apps/mobile/src/features/assistance/presentation/AssistanceScreen');
const { AssistanceScreen } = (imported.default ?? imported) as typeof import('../apps/mobile/src/features/assistance/presentation/AssistanceScreen');

for (const restoredOwner of ['first', 'second']) {
  test(`location permission across session verification with ${restoredOwner === 'first' ? 'the same' : 'a different'} account`, async () => {
    const dom = new JSDOM('<div id="app"></div>');
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
    const host = dom.window.document.querySelector('#app')!;
    const root = createRoot(host);
    const render = (snapshot: AuthSnapshot) => act(async () => {
      auth = snapshot;
      root.render(createElement(AssistanceScreen));
    });
    calls.length = 0;
    try {
      await render(signedIn('first'));
      const locationButton = [...host.querySelectorAll('button')].find(button => button.textContent === 'Usar mi ubicación');
      assert.ok(locationButton);
      await act(async () => locationButton.click());
      await render({ status: 'loading' });
      await act(async () => answerPermission(true));
      assert.equal(host.textContent, messages.es.verifying);
      assert.deepEqual(calls, ['permission']);

      await render(signedIn(restoredOwner));
      if (restoredOwner === 'first') {
        assert.deepEqual(calls, ['permission', 'location', { kind: 'nearby', locationAuthorized: true, coordinates }]);
        assert.match(host.textContent, /No encontramos prestadores en esa zona/);
      } else {
        assert.deepEqual(calls, ['permission']);
        assert.doesNotMatch(host.textContent, /No encontramos prestadores en esa zona/);
      }
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
}
