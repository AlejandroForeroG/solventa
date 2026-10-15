import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { theme } from '@/theme';
import { AuthenticationProvider } from '@/features/authentication/presentation/AuthenticationProvider';

export default function RootLayout() {
  return (
    <AuthenticationProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          contentStyle: { backgroundColor: theme.colors.background },
          headerShown: false,
        }}
      />
    </AuthenticationProvider>
  );
}
