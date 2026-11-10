import { Stack, useIsFocused } from 'expo-router';

import { AssistanceScreen } from '@/features/assistance/presentation/AssistanceScreen';
import { useNavigationMessages } from '@/features/navigation/presentation/navigation-messages';
import { theme } from '@/theme';

export default function AssistanceProvidersRoute() {
  const copy = useNavigationMessages();
  const focused = useIsFocused();
  return <>
    <Stack.Screen options={{ headerShown: true, title: copy.assistance, headerBackButtonDisplayMode: 'minimal',
      headerStyle: { backgroundColor: theme.colors.background }, headerTintColor: theme.colors.foreground, headerShadowVisible: false }} />
    {focused && <AssistanceScreen />}
  </>;
}
