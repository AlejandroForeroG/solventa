import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { theme } from '@/theme';
import { AuthenticationProvider } from '@/features/authentication/presentation/AuthenticationProvider';
import { DraftSyncProvider } from '@/features/claim-drafts/presentation/DraftSyncProvider';
import { useAppMessages } from '@/shared/i18n/use-app-messages';

export const unstable_settings = { initialRouteName: '(main)' };

export default function RootLayout() {
  const copy = useAppMessages();
  return (
    <AuthenticationProvider>
      <DraftSyncProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          contentStyle: { backgroundColor: theme.colors.background },
          headerShown: false,
        }}
      >
        <Stack.Screen name="notification-preferences" options={{
          headerShown: true,
          title: copy.actions.notificationPreferences,
          headerBackButtonDisplayMode: 'minimal',
          headerStyle: { backgroundColor: theme.colors.background },
          headerTintColor: theme.colors.foreground,
          headerShadowVisible: false,
        }} />
      </Stack>
      </DraftSyncProvider>
    </AuthenticationProvider>
  );
}
