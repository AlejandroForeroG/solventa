import { router } from 'expo-router';
import type { Href } from 'expo-router';
import type { PropsWithChildren } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuthentication } from '@/features/authentication/presentation/AuthenticationProvider';
import { WelcomeScreen } from '@/features/welcome/presentation/WelcomeScreen';
import { theme } from '@/theme';
import { useNavigationMessages } from './navigation-messages';

export function HomeScreen() {
  const auth = useAuthentication();
  const copy = useNavigationMessages();
  if (auth.status !== 'authenticated') return <WelcomeScreen />;

  return <Page title={copy.homeTitle}>
    <Tile title={copy.assistance} detail={copy.assistanceDetail} href="/assistance-providers" />
    <Tile title={copy.wallet} detail={copy.walletDetail} href="/wallet" />
    <Tile title={copy.claims} detail={copy.claimsDetail} href="/claims" />
    <Tile title={copy.alerts} detail={copy.alertsDetail} href="/alerts" />
  </Page>;
}

export function AlertsScreen() {
  const auth = useAuthentication();
  const copy = useNavigationMessages();

  return <Page title={copy.alerts}>
    {auth.status === 'authenticated' ? <View style={styles.card}>
      <Text style={styles.detail}>{copy.alertsUnavailable}</Text>
    </View> : <Tile title={copy.signIn} detail={copy.back} href="/" />}
  </Page>;
}

export function ClaimsScreen() {
  const auth = useAuthentication();
  const copy = useNavigationMessages();

  return <Page title={copy.claims}>
    {auth.status === 'authenticated'
      ? <Tile title={copy.assistance} detail={copy.assistanceDetail} href="/assistance-providers" />
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

function Tile({ title, detail, href }: { title: string; detail: string; href: Href }) {
  return <Pressable accessibilityRole="link" onPress={() => router.navigate(href)}
    style={({ pressed }) => [styles.card, styles.tile, pressed && styles.pressed]}>
    <View style={styles.tileText}>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={styles.detail}>{detail}</Text>
    </View>
    <Text accessible={false} style={styles.chevron}>›</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  content: { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.xl, gap: 14,
    width: '100%', maxWidth: 520, alignSelf: 'center' },
  title: { color: theme.colors.foreground, fontSize: 32, fontWeight: '700', letterSpacing: -0.8, marginBottom: 6 },
  card: { padding: 20, borderRadius: 24, backgroundColor: theme.colors.surface, gap: 5 },
  tile: { flexDirection: 'row', alignItems: 'center', minHeight: 68, gap: 12 },
  tileText: { flex: 1, gap: 4 },
  cardTitle: { color: theme.colors.foreground, fontSize: 18, fontWeight: '700' },
  detail: { color: theme.colors.muted, fontSize: 14, lineHeight: 20 },
  chevron: { color: theme.colors.primaryDark, fontSize: 24 },
  pressed: { opacity: 0.72 },
});
