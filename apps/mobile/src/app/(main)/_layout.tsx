import { Tabs } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
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
    <Tabs.Screen name="notification-preferences" options={{ title: copy.alerts, tabBarIcon: icons.alerts }} />
    <Tabs.Screen name="profile" options={{ title: copy.profile, tabBarIcon: icons.profile }} />
  </Tabs>;
}

function icon(tab: 'home' | 'wallet' | 'claims' | 'alerts' | 'profile') {
  return function TabIcon({ focused, color }: { focused: boolean; color: ColorValue }) {
    if (tab === 'claims') return <View style={styles.centerIcon} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Text style={styles.plus}>+</Text>
    </View>;
    return <View accessible={false} style={[styles.icon, tab === 'profile' && styles.round,
      { borderColor: color }, focused && { backgroundColor: color }]}>
      <View style={[styles.iconDetail, tab === 'home' && styles.homeDetail, tab === 'wallet' && styles.walletDetail,
        (tab === 'alerts' || tab === 'profile') && styles.dot,
        { backgroundColor: focused ? theme.colors.surface : color }]} />
    </View>;
  };
}

const icons = { home: icon('home'), wallet: icon('wallet'), claims: icon('claims'), alerts: icon('alerts'), profile: icon('profile') };

const styles = StyleSheet.create({
  scene: { backgroundColor: theme.colors.background },
  bar: { backgroundColor: theme.colors.surface, borderTopColor: theme.colors.border },
  hidden: { display: 'none' },
  label: { fontSize: 10, fontWeight: '600' },
  icon: { width: 25, height: 25, borderWidth: 2, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  iconDetail: { width: 9, height: 2, borderRadius: 2 },
  homeDetail: { width: 8, height: 8, borderRadius: 1, transform: [{ rotate: '45deg' }] },
  walletDetail: { width: 12, height: 7, borderRadius: 2 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  round: { borderRadius: 13 },
  centerIcon: { width: 33, height: 33, borderRadius: 17, backgroundColor: theme.colors.primaryDark,
    alignItems: 'center', justifyContent: 'center' },
  plus: { fontSize: 24, lineHeight: 27, fontWeight: '600', color: theme.colors.mint },
});
