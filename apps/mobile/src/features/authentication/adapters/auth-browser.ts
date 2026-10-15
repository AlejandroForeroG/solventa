import * as WebBrowser from 'expo-web-browser';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { AuthFailure } from '../domain/session';
import { createAuthBrowser } from './browser-session';

function assertAvailable() {
  if (Platform.OS === 'web' || Constants.appOwnership === 'expo') throw new AuthFailure('native_required');
}

export const authBrowser = createAuthBrowser({
  assertAvailable,
  openSession: (url, callback, options) => WebBrowser.openAuthSessionAsync(url, callback, options),
});
