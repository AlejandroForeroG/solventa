import { randomUUID } from 'expo-crypto';
import * as Network from 'expo-network';
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type PropsWithChildren } from 'react';
import { AppState } from 'react-native';
import { useAuthenticatedSession, useAuthentication } from '../../authentication/presentation/AuthenticationProvider';
import { createDraftApi } from '../adapters/draft-api';
import { protectedDraftStorage } from '../adapters/native-draft-storage';
import { DraftSync } from '../application/draft-sync';
import { sameOwner, type DraftOwner } from '../domain/draft';

const Context = createContext<DraftSync | null>(null);
const REVALIDATING = new Set(['loading', 'locked', 'biometricPrompt', 'authorizing']);

export function DraftSyncProvider({ children }: PropsWithChildren) {
  const auth = useAuthentication();
  const session = useAuthenticatedSession();
  const [sync] = useState(() => new DraftSync({ storage: protectedDraftStorage, api: createDraftApi(session.baseUrl, session), newId: randomUUID, now: Date.now }));
  const owner = useRef<DraftOwner | null>(null);
  const authentication = useRef({ status: auth.status, failure: auth.failure, retry: auth.retry });
  const pumping = useRef(false);
  const pump = useCallback(async (mayUnlock: boolean) => {
    const principal = owner.current;
    if (AppState.currentState !== 'active' || pumping.current) return;
    pumping.current = true;
    try {
      const network = await Network.getNetworkStateAsync();
      if (network.isConnected === false || network.isInternetReachable === false) return;
      if (!principal) {
        const latest = authentication.current;
        if (latest.status === 'blocked' && latest.failure === 'unavailable' && await protectedDraftStorage.hasPending()) await latest.retry();
        return;
      }
      if (!owner.current || !sameOwner(owner.current, principal) || AppState.currentState !== 'active') return;
      if (sync.getSnapshot().status !== 'ready') {
        if (!mayUnlock || !await protectedDraftStorage.hasPending()) return;
        await sync.open(principal);
      }
      if (!owner.current || !sameOwner(owner.current, principal) || AppState.currentState !== 'active') return;
      await sync.sync(principal);
    } finally { pumping.current = false; }
  }, [sync]);

  useEffect(() => {
    authentication.current = { status: auth.status, failure: auth.failure, retry: auth.retry };
    owner.current = auth.status === 'authenticated' && auth.principal ? auth.principal : null;
    if (owner.current) void pump(true).catch(() => undefined);
    else if (!(auth.status === 'blocked' && auth.failure === 'unavailable')
      && !REVALIDATING.has(auth.status)) sync.lock();
  }, [auth.status, auth.failure, auth.principal, auth.retry, pump, sync]);
  useEffect(() => {
    const listener = Network.addNetworkStateListener(state => {
      if (state.isConnected !== false && state.isInternetReachable !== false) void pump(true).catch(() => undefined);
    });
    const lifecycle = AppState.addEventListener('change', state => {
      // A system authentication prompt may be inactive, but a genuinely backgrounded app always loses access immediately.
      if (state === 'background' || (state !== 'active' && sync.getSnapshot().status !== 'loading')) sync.lock();
      else if (state === 'active') void pump(true).catch(() => undefined);
    });
    const interval = setInterval(() => { void pump(false).catch(() => undefined); }, 5000);
    return () => { listener.remove(); lifecycle.remove(); clearInterval(interval); sync.lock(); };
  }, [pump, sync]);
  return <Context.Provider value={sync}>{children}</Context.Provider>;
}

export function useDraftSync() {
  const sync = useContext(Context);
  if (!sync) throw new Error('DraftSyncProvider is required');
  const snapshot = useSyncExternalStore(sync.subscribe, sync.getSnapshot, sync.getSnapshot);
  return { sync, snapshot };
}
