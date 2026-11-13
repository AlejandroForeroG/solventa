import { useIsFocused } from 'expo-router';

import { NotificationPreferencesScreen } from '@/features/notification-preferences/presentation/NotificationPreferencesScreen';

export default function NotificationPreferencesRoute() {
  return useIsFocused() ? <NotificationPreferencesScreen /> : null;
}
