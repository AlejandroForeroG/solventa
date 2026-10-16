import { useLocales } from 'expo-localization';
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { getAppMessages } from './device-language';
import { messages } from './messages';

function subscribeToForeground(refresh: () => void) {
  const subscription = AppState.addEventListener('change', state => { if (state === 'active') refresh(); });
  return () => subscription.remove();
}

export function useAppMessages() {
  // Native/browser locale events also trigger a render, which rereads the current snapshot.
  useLocales();
  return useSyncExternalStore(subscribeToForeground, getAppMessages, () => messages.es);
}
