import { router, useIsFocused } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { Href } from 'expo-router';
import type { PropsWithChildren } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuthentication } from '@/features/authentication/presentation/AuthenticationProvider';
import { WelcomeScreen } from '@/features/welcome/presentation/WelcomeScreen';
import { NotificationPreferencesScreen } from '@/features/notification-preferences/presentation/NotificationPreferencesScreen';
import { theme } from '@/theme';
import { useNavigationMessages } from './navigation-messages';

export function HomeScreen() {
  const auth = useAuthentication();
  const copy = useNavigationMessages();
  if (auth.status !== 'authenticated') return <WelcomeScreen />;

  return <Page title={copy.homeTitle}>
    <Tile icon="shield-checkmark-outline" title={copy.wallet} detail={copy.walletDetail} href="/wallet" />
    <Tile icon="document-text-outline" title={copy.claims} detail={copy.claimsDetail} href="/claims" />
    <Tile icon="create-outline" title={copy.drafts} detail={copy.draftsDetail} href="/claim-drafts" />
    <Tile icon="location-outline" title={copy.assistance} detail={copy.assistanceDetail} href="/assistance-providers" />
  </Page>;
}

export function AlertsScreen() {
  const focused = useIsFocused();
  return <SafeAreaView style={styles.safe} edges={['top']}>
    {focused && <NotificationPreferencesScreen />}
  </SafeAreaView>;
}

export function ClaimsScreen() {
  const auth = useAuthentication();
  const copy = useNavigationMessages();

  return <Page title={copy.claims}>
    {auth.status === 'authenticated'
      ? <>
        <Tile title={copy.reportClaim} detail={copy.reportClaimDetail} href="/claim-report" />
        <Tile icon="receipt-outline" title={copy.payments} detail={copy.paymentsDetail} href="/claim-payments" />
        <Tile icon="create-outline" title={copy.drafts} detail={copy.draftsDetail} href="/claim-drafts" />
        <Tile icon="location-outline" title={copy.assistance} detail={copy.assistanceDetail} href="/assistance-providers" />
      </>
      : <Tile title={copy.signIn} detail={copy.back} href="/" />}
  </Page>;
}

function Page({ title, children }: PropsWithChildren<{ title: string }>) {
  return <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
    <ScrollView contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      {children}
    </ScrollView>
  </SafeAreaView>;
}

function Tile({ title, detail, href, icon = 'document-text-outline' }: { title: string; detail: string; href: Href; icon?: React.ComponentProps<typeof Ionicons>['name'] }) {
  const { fontScale } = useWindowDimensions();
  const stacked = fontScale > 1.4;
  return <Pressable accessibilityRole="link" accessibilityLabel={`${title}. ${detail}`} onPress={() => router.navigate(href)}
    style={({ pressed }) => [styles.card, styles.tile, stacked && styles.tileStacked, pressed && styles.pressed]}>
    <View style={stacked && styles.tileHeading} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={styles.tileIcon}><Ionicons name={icon} size={23} color={theme.colors.primaryDark} /></View>
      {stacked && <Ionicons accessible={false} name="chevron-forward" size={18} color={theme.colors.muted} />}
    </View>
    <View style={[styles.tileText, stacked && styles.tileTextStacked]}>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={styles.detail}>{detail}</Text>
    </View>
    {!stacked && <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><Ionicons accessible={false} name="chevron-forward" size={18} color={theme.colors.muted} /></View>}
  </Pressable>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  content: { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.xl, gap: 14,
    width: '100%', maxWidth: 520, alignSelf: 'center' },
  title: { color: theme.colors.foreground, fontSize: 32, fontWeight: '700', letterSpacing: -0.8, marginBottom: 6 },
  card: { padding: 18, borderRadius: 20, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, gap: 5 },
  tile: { flexDirection: 'row', alignItems: 'center', minHeight: 68, gap: 12 },
  tileStacked: { flexDirection: 'column', alignItems: 'stretch' },
  tileHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tileText: { flex: 1, gap: 4 },
  tileTextStacked: { flex: 0 },
  tileIcon: { width: 44, height: 44, backgroundColor: theme.colors.mint, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { color: theme.colors.foreground, fontSize: 18, fontWeight: '700' },
  detail: { color: theme.colors.muted, fontSize: 14, lineHeight: 20 },
  chevron: { color: theme.colors.primaryDark, fontSize: 24 },
  pressed: { opacity: 0.72 },
});
