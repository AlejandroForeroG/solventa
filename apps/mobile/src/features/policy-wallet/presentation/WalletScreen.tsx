import { router } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '@/theme';
import { messages } from '@/shared/i18n/messages';
import { useAppMessages } from '@/shared/i18n/use-app-messages';
import { useAuthenticatedSession, useAuthentication } from '@/features/authentication/presentation/AuthenticationProvider';
import type { CachedPolicy } from '../../policy-cache/domain/cached-policy';
import { createPolicyWallet } from '../adapters/create-policy-wallet';
import { policyReference, validityAt, walletAccessFor } from '../domain/wallet';
import type { WalletAccess } from '../domain/wallet';
import type { WalletSnapshot } from '../domain/wallet';
import { formatDate, formatDateTime, formatMoney } from './format';
import { walletMessages } from './messages';
import { useNow } from './use-now';
import type { WalletLocale } from './messages';

type Ready = Extract<WalletSnapshot, { status: 'ready' }>;

export function WalletScreen() {
  const auth = useAuthentication();
  const locale: WalletLocale = useAppMessages() === messages.en ? 'en-US' : 'es-CO';
  const copy = walletMessages[locale];
  const access = walletAccessFor(auth);
  if (!access) return <SafeAreaView style={styles.safe}>
    <View style={styles.card}><Text style={styles.body}>{copy.signedOut}</Text>
      <Action label={copy.back} onPress={() => router.replace('/')} /></View>
  </SafeAreaView>;
  // A new owner or locale gets a new coordinator, so another account never sees the previous one's data.
  const key = access.mode === 'online' ? `${access.owner.clientId}:${access.owner.subjectToken}:${locale}` : `offline:${locale}`;
  return <Wallet key={key} locale={locale} access={access} />;
}

function Wallet({ locale, access }: { locale: WalletLocale; access: WalletAccess }) {
  const session = useAuthenticatedSession();
  const [wallet] = useState(() => createPolicyWallet(session.baseUrl, session, access.mode === 'online' ? access.owner : undefined));
  const state = useSyncExternalStore(wallet.subscribe, wallet.getSnapshot, wallet.getSnapshot);
  const [selected, select] = useState<string>();
  const copy = walletMessages[locale];
  const now = useNow();
  useEffect(() => {
    void wallet.unlock();
    const lifecycle = AppState.addEventListener('change', next => { if (next !== 'active') { select(undefined); wallet.lock(); } });
    return () => { lifecycle.remove(); wallet.lock(); };
  }, [wallet]);
  const policy = state.status === 'ready' ? state.policies.find(item => item.policyId === selected) : undefined;
  return <SafeAreaView style={styles.safe}>
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Action label={copy.back} secondary onPress={() => router.replace('/')} />
        <Text accessibilityRole="header" style={styles.title}>{copy.title}</Text>
        {state.status === 'locked' && <Locked state={state} locale={locale} onUnlock={() => void wallet.unlock()} />}
        {state.status === 'loading' && <ActivityIndicator accessibilityLabel={copy.loading} color={theme.colors.primary} />}
        {state.status === 'failed' && <>
          <Text accessibilityRole="alert" style={styles.notice}>{copy.failures[state.failure]}</Text>
          {state.failure !== 'unauthorized' && <Action label={copy.retry} onPress={() => void wallet.refresh()} />}
        </>}
        {state.status === 'ready' && <>
          <SourceBanner state={state} locale={locale} unverified={access.mode === 'offline'} />
          {policy ? <Detail policy={policy} state={state} locale={locale} now={now} onBack={() => select(undefined)} />
            : <List state={state} locale={locale} now={now} onOpen={select} />}
          {!policy && <Action label={copy.refresh} secondary onPress={() => void wallet.refresh()} />}
        </>}
      </View>
    </ScrollView>
  </SafeAreaView>;
}

function Locked({ state, locale, onUnlock }: { state: Extract<WalletSnapshot, { status: 'locked' }>; locale: WalletLocale; onUnlock: () => void }) {
  const copy = walletMessages[locale];
  return <View style={styles.section}>
    <Text accessibilityRole="header" style={styles.subtitle}>{copy.locked.title}</Text>
    <Text style={styles.body}>{copy.locked.body}</Text>
    {state.failure && <Text accessibilityRole="alert" style={styles.notice}>{copy.locked[state.failure]}</Text>}
    <Action label={copy.unlock} onPress={onUnlock} />
  </View>;
}

function SourceBanner({ state, locale, unverified }: { state: Ready; locale: WalletLocale; unverified: boolean }) {
  const copy = walletMessages[locale];
  const stored = state.source === 'stored';
  return <View accessibilityLiveRegion="polite" style={[styles.banner, stored && styles.bannerStored]}>
    <Text style={styles.bannerLabel}>{stored ? copy.stored.label : copy.online.label}</Text>
    <Text style={styles.body}>{stored ? copy.stored.detail : copy.online.detail}</Text>
    {stored && <Text style={styles.caption}>{copy.stored.lastSync}: {formatDateTime(state.syncedAt, locale)}</Text>}
    {unverified && <Text style={styles.caption}>{copy.unverified}</Text>}
    {!stored && !state.stored && <Text style={styles.caption}>{copy.notSaved}</Text>}
  </View>;
}

function List({ state, locale, now, onOpen }: { state: Ready; locale: WalletLocale; now: number; onOpen: (policyId: string) => void }) {
  const copy = walletMessages[locale];
  if (state.policies.length === 0) return <Text style={styles.body}>{copy.empty}</Text>;
  const sorted = [...state.policies].sort((a, b) => Date.parse(b.effectiveUntil) - Date.parse(a.effectiveUntil));
  return <View style={styles.section}>
    {sorted.map(policy => <Pressable key={policy.policyId} accessibilityRole="button" onPress={() => onOpen(policy.policyId)} style={styles.item}>
      <Text style={styles.itemTitle}>{copy.products[policy.product]}</Text>
      <Text style={styles.caption}>{policyReference(policy.policyId)} · {copy.validity[validityAt(policy, now)]}</Text>
      <Text style={styles.body}>{copy.fields.until}: {formatDate(policy.effectiveUntil, locale)} · {formatMoney(policy.premium, locale)}</Text>
      {state.stored && <Text style={styles.caption}>{copy.availableOffline}</Text>}
    </Pressable>)}
    {state.hasMore && <Text style={styles.caption}>{copy.hasMore}</Text>}
  </View>;
}

function Detail({ policy, state, locale, now, onBack }: { policy: CachedPolicy; state: Ready; locale: WalletLocale; now: number; onBack: () => void }) {
  const copy = walletMessages[locale];
  const { coverage } = policy;
  return <View style={styles.section}>
    <Action label={copy.backToList} secondary onPress={onBack} />
    <View style={styles.credential}>
      <Text style={styles.bannerLabel}>{copy.credential}</Text>
      <Text style={styles.itemTitle}>{copy.products[policy.product]}</Text>
      <Text style={styles.body}>{policyReference(policy.policyId)}</Text>
      <Text style={styles.caption}>{copy.validity[validityAt(policy, now)]} · {formatDate(policy.effectiveFrom, locale)} - {formatDate(policy.effectiveUntil, locale)}</Text>
      {state.source === 'stored' && <Text style={styles.caption}>{copy.stored.lastSync}: {formatDateTime(state.syncedAt, locale)}</Text>}
    </View>
    <Row label={copy.fields.premium} value={formatMoney(policy.premium, locale)} />
    <Text accessibilityRole="header" style={styles.subtitle}>{copy.coverage}</Text>
    {coverage.kind === 'mortgage_life'
      ? <Row label={`${copy.coverages.mortgage_life} · ${copy.coverages.sumInsured}`} value={formatMoney(coverage.sumInsured, locale)} />
      : <>
        <Row label={copy.coverages.threshold} value={`${coverage.thresholdMinutes} ${copy.coverages.minutes}`} />
        <Row label={copy.coverages.payout} value={formatMoney(coverage.payoutAmount, locale)} />
        <Row label={copy.coverages.flight} value={coverage.flightReference.slice(0, 8).toUpperCase()} />
      </>}
    <Text style={styles.caption}>{copy.document}</Text>
    {/* A report needs the server, so a stored copy never offers it. */}
    {state.source !== 'stored' && validityAt(policy, now) === 'active'
      && <Action label={copy.reportClaim} onPress={() => router.push({ pathname: '/claim-report', params: { policyId: policy.policyId } })} />}
  </View>;
}

function Row({ label, value }: { label: string; value: string }) {
  return <View style={styles.row}><Text style={styles.body}>{label}</Text><Text style={styles.value}>{value}</Text></View>;
}

function Action({ label, secondary = false, onPress }: { label: string; secondary?: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.button, secondary && styles.secondary, pressed && styles.dimmed]}>
    <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background }, content: { padding: 24, paddingVertical: 32 },
  card: { width: '100%', maxWidth: 480, alignSelf: 'center', padding: 24, borderRadius: 28, backgroundColor: theme.colors.surface, gap: 18 },
  title: { fontSize: 23, lineHeight: 30, color: theme.colors.foreground, fontWeight: '600' },
  subtitle: { fontSize: 18, lineHeight: 26, color: theme.colors.foreground, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 23, color: theme.colors.foreground, flexShrink: 1 }, caption: { fontSize: 12, lineHeight: 18, color: theme.colors.muted },
  notice: { padding: 14, borderRadius: 14, backgroundColor: theme.colors.warningSurface, color: theme.colors.warningText, fontSize: 14, lineHeight: 21 },
  section: { gap: 12 },
  banner: { padding: 14, borderRadius: 14, backgroundColor: theme.colors.mint, gap: 4 },
  bannerStored: { backgroundColor: theme.colors.warningSurface },
  bannerLabel: { fontSize: 12, lineHeight: 18, fontWeight: '700', letterSpacing: 0.6, color: theme.colors.onMint },
  item: { padding: 16, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 16, gap: 4, minHeight: 48 },
  itemTitle: { fontSize: 17, lineHeight: 24, fontWeight: '600', color: theme.colors.foreground },
  credential: { padding: 16, borderRadius: 16, backgroundColor: theme.colors.mint, gap: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 6, borderBottomWidth: 1, borderColor: theme.colors.border },
  value: { fontSize: 15, lineHeight: 23, fontWeight: '600', color: theme.colors.foreground },
  button: { minHeight: 54, backgroundColor: theme.colors.primaryDark, borderRadius: 16, padding: 16, justifyContent: 'center' },
  secondary: { backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border },
  buttonText: { fontSize: 15, lineHeight: 22, fontWeight: '600', textAlign: 'center', color: theme.colors.onPrimary }, secondaryText: { color: theme.colors.primaryDark }, dimmed: { opacity: 0.5 },
});
