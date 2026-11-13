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
let providers: unknown[] = [];
mock.module(new URL('features/assistance/adapters/assistance-api.ts', mobile).href, { namedExports: {
  createAssistanceApi: () => ({ search: async (request: unknown) => { calls.push(request); return providers; } }),
} });
// The request flow has its own tests; here it is a stub that records what the screen asks of it.
let requestSnapshot: unknown = { request: { kind: 'idle' }, own: { status: 'ready', requests: [] } };
const requestCalls: unknown[] = [];
const requestFlow = {
  subscribe: () => () => {}, getSnapshot: () => requestSnapshot,
  refresh: async () => { requestCalls.push('refresh'); }, review: (...args: unknown[]) => { requestCalls.push(['review', ...args]); },
  cancel: () => { requestCalls.push('cancel'); }, confirm: async () => { requestCalls.push('confirm'); },
};
mock.module(new URL('features/assistance/adapters/create-assistance-requests.ts', mobile).href, { namedExports: { createAssistanceRequests: () => requestFlow } });

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

const workshop = { id: 'demo-bog-workshop', kind: 'workshop', name: 'Taller de prueba Bogotá', city: 'Bogotá', address: 'Calle de prueba 10', phone: '+570000000001', hours: 'Lun–vie 08:00–17:00' };

test('a provider of the results can be requested, carrying the place the search used and nothing is asked before the customer confirms', async () => {
  const dom = new JSDOM('<div id="app"></div>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const host = dom.window.document.querySelector('#app')!;
  const root = createRoot(host);
  providers = [workshop];
  auth = signedIn('first');
  calls.length = 0; requestCalls.length = 0;
  try {
    await act(async () => root.render(createElement(AssistanceScreen)));
    assert.deepEqual(requestCalls, ['refresh'], 'the customer’s own requests are loaded when the screen opens');
    // The stubbed TextInput is uncontrolled, so the nearby search is the way into the results.
    const location = [...host.querySelectorAll('button')].find(button => button.textContent === 'Usar mi ubicación')!;
    await act(async () => location.click());
    await act(async () => answerPermission(true));
    assert.equal(requestCalls.filter(call => Array.isArray(call)).length, 0, 'finding providers asks for nothing');
    const ask = [...host.querySelectorAll('button')].find(button => button.textContent === 'Solicitar asistencia');
    assert.ok(ask, 'each provider offers the request');
    await act(async () => ask.click());
    assert.deepEqual(requestCalls.filter(call => Array.isArray(call)), [['review', workshop, { kind: 'device', latitude: coordinates.latitude, longitude: coordinates.longitude }]]);
    assert.equal(requestCalls.includes('confirm'), false, 'choosing a provider does not confirm the request');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    providers = [];
  }
});

test('the review names the provider and the place, a failure is told and can be retried, and a stored request shows its reference and state', async () => {
  const dom = new JSDOM('<div id="app"></div>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const host = dom.window.document.querySelector('#app')!;
  const root = createRoot(host);
  auth = signedIn('first');
  const own = { status: 'ready', requests: [{ id: '40000000-0000-4000-8000-000000000001', reference: 'ASI-7K2M9QXD', status: 'requested', provider: workshop, place: { kind: 'address', address: 'Calle de prueba 10, Bogotá' }, createdAt: '2026-11-12T22:30:00.000Z' }] };
  const press = async (label: string) => act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === label)!.click());
  try {
    requestSnapshot = { request: { kind: 'review', provider: workshop, place: { kind: 'device', latitude: 4.648, longitude: -74.098 } }, own };
    await act(async () => root.render(createElement(AssistanceScreen)));
    assert.match(host.textContent, /Revisa tu solicitud/); assert.match(host.textContent, /Taller de prueba Bogotá/);
    assert.match(host.textContent, /Tu ubicación actual/); assert.match(host.textContent, /compartes tu ubicación con esta solicitud/);
    assert.doesNotMatch(host.textContent, /Buscar/, 'the search steps aside while a request is under review');
    requestCalls.length = 0;
    await press('Confirmar solicitud'); await press('Volver');
    assert.deepEqual(requestCalls, ['confirm', 'cancel']);

    requestSnapshot = { request: { kind: 'failed', provider: workshop, place: { kind: 'address', address: 'Calle de prueba 10, Bogotá' }, failure: 'unavailable' }, own };
    await act(async () => root.render(createElement(AssistanceScreen)));
    assert.match(host.textContent, /no sabemos si quedó guardada/); assert.match(host.textContent, /no se creará una solicitud repetida/);
    assert.match(host.textContent, /Dirección: Calle de prueba 10, Bogotá/);
    assert.doesNotMatch(host.textContent, /Solicitud registrada/, 'a failed request is never shown as stored');

    requestSnapshot = { request: { kind: 'done', request: own.requests[0] }, own };
    await act(async () => root.render(createElement(AssistanceScreen)));
    assert.match(host.textContent, /Solicitud registrada/); assert.match(host.textContent, /ASI-7K2M9QXD/); assert.match(host.textContent, /Estado · Solicitada/);
    assert.match(host.textContent, /prestador es simulado/);
    assert.match(host.textContent, /Mis solicitudes/);

    requestSnapshot = { request: { kind: 'idle' }, own: { status: 'failed' } };
    await act(async () => root.render(createElement(AssistanceScreen)));
    assert.match(host.textContent, /No pudimos cargar tus solicitudes/);
    requestCalls.length = 0;
    await press('Reintentar');
    assert.deepEqual(requestCalls, ['refresh']);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    requestSnapshot = { request: { kind: 'idle' }, own: { status: 'ready', requests: [] } };
  }
});
