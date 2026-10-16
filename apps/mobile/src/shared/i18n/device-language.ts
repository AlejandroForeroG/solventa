import { getLocales } from 'expo-localization';

import { messagesForLocales } from './messages';

export function getAppMessages() {
  return messagesForLocales(getLocales().map(locale => locale.languageTag));
}

