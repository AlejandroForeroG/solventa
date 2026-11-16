import { Tabs } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet } from 'react-native';
import type { ColorValue } from 'react-native';

import { useAuthentication } from '@/features/authentication/presentation/AuthenticationProvider';
import { useNavigationMessages } from '@/features/navigation/presentation/navigation-messages';
import { theme } from '@/theme';

export default function MainLayout() {
  const auth = useAuthentication();
  const copy = useNavigationMessages();

  return <Tabs screenOptions={{
    headerShown: false,
    sceneStyle: styles.scene,
    tabBarStyle: auth.status === 'authenticated' ? styles.bar : styles.hidden,
    tabBarActiveTintColor: theme.colors.primaryDark,
    tabBarInactiveTintColor: theme.colors.muted,
    tabBarLabelPosition: 'below-icon',
    tabBarLabelStyle: styles.label,
    tabBarHideOnKeyboard: true,
  }}>
    <Tabs.Screen name="index" options={{ title: copy.home, tabBarIcon: icons.home }} />
    <Tabs.Screen name="wallet" options={{ title: copy.wallet, tabBarIcon: icons.wallet }} />
    <Tabs.Screen name="claims" options={{ title: copy.claims, tabBarIcon: icons.claims }} />
    <Tabs.Screen name="alerts" options={{ title: copy.alerts, tabBarIcon: icons.alerts }} />
    <Tabs.Screen name="profile" options={{ title: copy.profile, tabBarIcon: icons.profile }} />
  </Tabs>;
}

function icon(tab: 'home' | 'wallet' | 'claims' | 'alerts' | 'profile') {
  const names = { home: 'home-outline', wallet: 'shield-checkmark-outline', claims: 'document-text-outline', alerts: 'notifications-outline', profile: 'person-circle-outline' } as const;
  return function TabIcon({ color }: { focused: boolean; color: ColorValue }) {
    return <Ionicons accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" name={names[tab]} size={24} color={color} />;
  };
}

const icons = { home: icon('home'), wallet: icon('wallet'), claims: icon('claims'), alerts: icon('alerts'), profile: icon('profile') };

const styles = StyleSheet.create({
  scene: { backgroundColor: theme.colors.background },
  bar: { backgroundColor: theme.colors.surface, borderTopColor: theme.colors.border, minHeight: 64, paddingTop: 6, paddingBottom: 6 },
  hidden: { display: 'none' },
  label: { fontSize: 11, fontWeight: '600' },
});
