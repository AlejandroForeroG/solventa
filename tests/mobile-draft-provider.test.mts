import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const mobile = new URL('../apps/mobile/src/', import.meta.url);
const effects: Array<() => void | (() => void)> = [];
const hooks: unknown[] = [];
let cursor = 0, pending = true, retries = 0;
let auth: Record<string, unknown> = { status: 'blocked', failure: 'unavailable', retry: async () => { retries++; } };
let network = { isConnected: true, isInternetReachable: true };
let networkListener: ((state: typeof network) => void) | undefined;
let tick: (() => void) | undefined;
const appState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
const sent: unknown[] = [];
let queueState = { status: 'locked' };
Object.defineProperty(globalThis, 'React', { configurable: true, value: { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) } });
mock.method(globalThis, 'setInterval', ((callback: () => void) => { tick = callback; return undefined; }) as typeof setInterval);
mock.module('react', { namedExports: {
  createContext: () => ({ Provider: 'DraftContext' }), useContext: () => null,
  useState: (factory: () => unknown) => { const index = cursor++; hooks[index] ??= factory(); return [hooks[index]]; },
  useRef: (value: unknown) => { const index = cursor++; hooks[index] ??= { current: value }; return hooks[index]; },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => { effects.push(effect); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
} });
mock.module('react-native', { namedExports: { AppState: appState } });
mock.module('expo-crypto', { namedExports: { randomUUID: () => 'unused' } });
mock.module('expo-network', { namedExports: {
  getNetworkStateAsync: async () => network,
  addNetworkStateListener: (callback: typeof networkListener) => { networkListener = callback; return { remove() {} }; },
} });
mock.module(new URL('features/authentication/presentation/AuthenticationProvider.tsx', mobile).href, { namedExports: {
  useAuthentication: () => auth, useAuthenticatedSession: () => ({ baseUrl: 'https://dev.solventa.site' }),
} });
mock.module(new URL('features/claim-drafts/adapters/native-draft-storage.ts', mobile).href, { namedExports: {
  protectedDraftStorage: { hasPending: async () => pending },
} });
mock.module(new URL('features/claim-drafts/adapters/draft-api.ts', mobile).href, { namedExports: { createDraftApi: () => ({}) } });
mock.module(new URL('features/claim-drafts/application/draft-sync.ts', mobile).href, { namedExports: { DraftSync: class {
  getSnapshot = () => queueState;
  open = async () => { queueState = { status: 'ready' }; };
  lock = () => { queueState = { status: 'locked' }; };
  sync = async (owner: unknown) => { sent.push(owner); };
} } });
const { DraftSyncProvider } = await import('../apps/mobile/src/features/claim-drafts/presentation/DraftSyncProvider');
const flush = () => new Promise(resolve => setImmediate(resolve));
function render() { cursor = 0; effects.length = 0; DraftSyncProvider({ children: null }); effects[0](); }

test('foreground recovery revalidates an unavailable stored session before automatically sending pending work', async () => {
  render(); const cleanup = effects[1]();
  networkListener?.(network); await flush(); assert.equal(retries, 1); assert.equal(sent.length, 0);
  pending = false; tick?.(); await flush(); assert.equal(retries, 1, 'No pending draft needs recovery');
  pending = true; network = { isConnected: false, isInternetReachable: false }; tick?.(); await flush(); assert.equal(retries, 1);
  network = { isConnected: true, isInternetReachable: true };
  appState.currentState = 'background'; networkListener?.(network); await flush(); assert.equal(retries, 1);
  appState.currentState = 'active';
  for (const status of ['signedOut', 'logoutPending', 'locked', 'blocked']) {
    auth = { ...auth, status, failure: 'forbidden' }; render(); tick?.(); await flush(); assert.equal(retries, 1, status);
  }
  const principal = { clientId: 'synthetic-client', subjectToken: 'synthetic-subject' };
  auth = { ...auth, status: 'authenticated', principal }; render(); await flush();
  assert.deepEqual(sent, [principal], 'Only the subsequently verified principal can send');
  if (typeof cleanup === 'function') cleanup();
});
