import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { AuthSnapshot } from '../apps/mobile/src/features/authentication/domain/session';
import { messages } from '../apps/mobile/src/shared/i18n/messages';

const mobile = new URL('../apps/mobile/src/', import.meta.url);
const eventId = '70000000-0000-4000-8000-000000000001';
const policyId = '60000000-0000-4000-8000-000000000001';
let auth: AuthSnapshot;
let route: { eventId: string | string[] } = { eventId };
let resolveDestination: (value: { kind: 'policy'; policyId: string; section: 'history' }) => void;
let failDestination: (error: Error) => void;
let reads = 0;
const opened: string[] = [];
const container = ({ children }: { children: ReactNode }) => createElement('div', null, children);
mock.module('react-native', { namedExports: {
  ActivityIndicator: () => null, View: container, Text: container, StyleSheet: { create: (value: unknown) => value },
  Linking: { openURL: async (url: string) => { opened.push(url); } },
  Pressable: ({ children, disabled, onPress }: { children: ReactNode; disabled?: boolean; onPress(): void }) => createElement('button', { disabled, onClick: onPress }, children),
} });
mock.module('expo-router', { namedExports: { useLocalSearchParams: () => route, router: { replace() {} } } });
mock.module('react-native-safe-area-context', { namedExports: { SafeAreaView: container } });
mock.module(new URL('theme/index.ts', mobile).href, { namedExports: { theme: { colors: {} } } });
mock.module(new URL('shared/i18n/use-app-messages.ts', mobile).href, { namedExports: { useAppMessages: () => messages.es } });
mock.module(new URL('features/notices/presentation/notice-messages.ts', mobile).href, { namedExports: { useNoticeMessages: () => ({ title: 'Aviso', signIn: 'Inicia sesión', open: 'Ver detalle', retry: 'Reintentar', actionFailed: 'Aviso no disponible', back: 'Volver' }) } });
mock.module(new URL('features/authentication/presentation/AuthenticationProvider.tsx', mobile).href, { namedExports: {
  useAuthentication: () => auth, useAuthenticatedSession: () => ({ baseUrl: 'https://dev.solventa.site' }),
} });
mock.module(new URL('features/notices/adapters/notices-api.ts', mobile).href, { namedExports: {
  createNoticesApi: () => ({ destination: async () => { reads++; return new Promise((resolve, reject) => { resolveDestination = resolve; failDestination = reject; }); } }),
} });
const imported = await import('../apps/mobile/src/features/notices/presentation/NoticeActionScreen');
const { NoticeActionScreen } = (imported.default ?? imported) as typeof import('../apps/mobile/src/features/notices/presentation/NoticeActionScreen');
const signedIn = (clientId: string): AuthSnapshot => ({ status: 'authenticated', principal: { clientId, subjectToken: 'subject' } });

test('a late destination never opens after session expiry or an owner switch; a fresh retry rereads it', async () => {
  const dom = new JSDOM('<div id="app"></div>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const host = dom.window.document.querySelector('#app')!;
  const root = createRoot(host);
  const render = async (snapshot: AuthSnapshot) => act(async () => { auth = snapshot; root.render(createElement(NoticeActionScreen)); });
  const click = async (label: string) => act(async () => { const button = [...host.querySelectorAll('button')].find(item => item.textContent === label); assert.ok(button); button.click(); });
  const target = { kind: 'policy' as const, policyId, section: 'history' as const };
  try {
    reads = 0; opened.length = 0;
    await render(signedIn('first'));
    await click('Ver detalle');
    await render({ status: 'signedOut' });
    await act(async () => resolveDestination(target));
    assert.deepEqual(opened, []);
    assert.equal(reads, 1);
    await render(signedIn('first'));
    await click('Ver detalle');
    await render(signedIn('second'));
    await act(async () => resolveDestination(target));
    assert.deepEqual(opened, []);
    await click('Ver detalle');
    await act(async () => failDestination(new Error('unavailable')));
    assert.match(host.textContent, /Aviso no disponible/);
    await click('Reintentar');
    await act(async () => resolveDestination(target));
    assert.deepEqual(opened, [`https://dev.solventa.site/polizas#policy=${policyId}&section=history`]);
    assert.equal(reads, 4);
    route = { eventId: ['invalid', eventId] };
    await render(signedIn('second'));
    assert.match(host.textContent, /Aviso no disponible/);
    assert.equal(host.querySelectorAll('button').length, 1);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
