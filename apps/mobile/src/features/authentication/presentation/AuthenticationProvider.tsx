import * as Linking from 'expo-linking';
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { PropsWithChildren } from 'react';
import { AppState } from 'react-native';

import { Authentication } from '../application/authentication';
import { authBrowser } from '../adapters/auth-browser';
import { parseCallback } from '../adapters/callback';
import { biometricVault, secureTokenStore } from '../adapters/secure-token-store';
import { createSessionApi } from '../adapters/solventa-session';
import { workosIdentity } from '../adapters/workos';

const Context = createContext<Authentication | null>(null);

export function AuthenticationProvider({ children }: PropsWithChildren) {
  const [authentication] = useState(() => {
    const baseUrl = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'https://solventa-web-staging.ja-forerog1.workers.dev';
    return new Authentication({
      baseUrl, store: secureTokenStore, identity: workosIdentity,
      api: createSessionApi(baseUrl), browser: authBrowser, now: Date.now, parseCallback,
      biometrics: biometricVault,
    });
  });

  useEffect(() => {
    let disposed = false;
    const handleUrl = (url: string) => {
      if (url.startsWith('solventa://auth/')) void authentication.complete(url);
    };
    const links = Linking.addEventListener('url', ({ url }) => handleUrl(url));
    void Linking.getInitialURL().then(async url => {
      if (disposed) return;
      if (url?.startsWith('solventa://auth/')) await authentication.complete(url);
      else await authentication.restore();
    }).catch(() => { if (!disposed) void authentication.restore(); });
    const lifecycle = AppState.addEventListener('change', state => {
      if (state !== 'active') authentication.lock();
      else {
        authentication.resume();
        if (!['authorizing', 'biometricPrompt'].includes(authentication.getSnapshot().status)) void authentication.restore();
      }
    });
    return () => { disposed = true; links.remove(); lifecycle.remove(); };
  }, [authentication]);

  return <Context.Provider value={authentication}>{children}</Context.Provider>;
}

export function useAuthentication() {
  const authentication = useContext(Context);
  if (!authentication) throw new Error('AuthenticationProvider is required');
  const snapshot = useSyncExternalStore(authentication.subscribe, authentication.getSnapshot, authentication.getSnapshot);
  return { ...snapshot, signIn: authentication.signIn, signOut: authentication.signOut, retry: authentication.retry,
    cancel: authentication.cancel, enableBiometrics: authentication.enableBiometrics, unlock: authentication.unlock, revokeDevice: authentication.revokeDevice };
}

// An adapter/composition port, separate from the UI-safe authentication snapshot.
export function useAuthenticatedSession() {
  const authentication = useContext(Context);
  if (!authentication) throw new Error('AuthenticationProvider is required');
  return { execute: authentication.withSession, baseUrl: authentication.getApiBaseUrl() };
}
