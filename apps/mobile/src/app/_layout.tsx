import { router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable } from 'react-native';

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
          headerBackVisible: false,
          headerLeft: ({ canGoBack }) => canGoBack ? <Pressable accessibilityRole="button" accessibilityLabel={copy.actions.back}
            onPress={() => router.back()} style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons accessible={false} name="arrow-back" size={24} color={theme.colors.foreground} /></Pressable> : null,
        }}
      >
        {(['claim-tracking/index', 'claim-tracking/[claimId]'] as const).map(name =>
          <Stack.Screen key={name} name={name} options={{ headerShown: true, headerTitle: '', headerLeft: undefined, headerBackVisible: true,
            headerBackButtonDisplayMode: 'minimal', headerStyle: { backgroundColor: theme.colors.background },
            headerTintColor: theme.colors.foreground, headerShadowVisible: false }} />)}
        <Stack.Screen name="claim-payments" options={{ headerShown: true, title: '', headerTitle: '', headerBackButtonDisplayMode: 'minimal',
          headerStyle: { backgroundColor: theme.colors.background }, headerTintColor: theme.colors.foreground, headerShadowVisible: false }} />
        <Stack.Screen name="notification-preferences" options={{
          headerShown: true,
          title: copy.actions.notificationPreferences,
          headerTitle: '',
          headerBackButtonDisplayMode: 'minimal',
          headerStyle: { backgroundColor: theme.colors.background },
          headerTintColor: theme.colors.foreground,
          headerShadowVisible: false,
        }} />
        {([['claim-report', copy.actions.reportClaim], ['claim-drafts', copy.actions.drafts], ['choose-draft-policy', copy.actions.drafts], ['identity-verification', copy.actions.verifyIdentity]] as const).map(([name, title]) =>
          <Stack.Screen key={name} name={name} options={{ headerShown: true, title, headerTitle: '', headerBackButtonDisplayMode: 'minimal',
            headerStyle: { backgroundColor: theme.colors.background }, headerTintColor: theme.colors.foreground, headerShadowVisible: false }} />)}
      </Stack>
      </DraftSyncProvider>
    </AuthenticationProvider>
  );
}
