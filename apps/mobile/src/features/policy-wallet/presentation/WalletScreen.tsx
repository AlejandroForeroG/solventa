import { router } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, Linking, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '@/theme';
import { usePageFocus } from '@/shared/presentation/use-page-focus';
import { messages } from '@/shared/i18n/messages';
import { useAppMessages } from '@/shared/i18n/use-app-messages';
import { useAuthenticatedSession, useAuthentication } from '@/features/authentication/presentation/AuthenticationProvider';
import type { CachedPolicy } from '../../policy-cache/domain/cached-policy';
import { isReportableProduct } from '../../claim-report/domain/report';
import { createPolicyWallet } from '../adapters/create-policy-wallet';
import { policyReference, validityAt, walletAccessFor, type WalletAccess, type WalletSnapshot } from '../domain/wallet';
import { formatDate, formatDateTime, formatMoney } from './format';
import { walletMessages, type WalletLocale } from './messages';
import { useNow } from './use-now';
import { PolicyPages } from './PolicyPages';

type Ready = Extract<WalletSnapshot, { status: 'ready' }>;
type PolicyFilter = keyof (typeof walletMessages)['es-CO']['filters'];

export function WalletScreen({ draftSelection = false }: { draftSelection?: boolean } = {}) {
  const auth = useAuthentication();
  const appCopy = useAppMessages();
  const locale: WalletLocale = appCopy === messages.en ? 'en-US' : 'es-CO';
  const copy = walletMessages[locale];
  const access = walletAccessFor(auth);
  if (!access) return <SafeAreaView style={styles.safe}>
    <ScrollView contentContainerStyle={styles.content}><View style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>{copy.title}</Text>
      {auth.failure && <Text accessibilityRole="alert" style={styles.notice}>{appCopy.failures[auth.failure]}</Text>}
      <Text style={styles.body}>{auth.status === 'loading' ? appCopy.verifying : auth.status === 'authorizing' ? appCopy.authorizing : copy.signedOut}</Text>
      {auth.status === 'signedOut' && <Action label={appCopy.actions.signIn} onPress={() => void auth.signIn()} />}
      {auth.status === 'authorizing' && <Action label={appCopy.actions.cancel} onPress={() => void auth.cancel()} />}
      <Action secondary label={copy.back} onPress={() => router.replace('/')} />
    </View></ScrollView>
  </SafeAreaView>;
  // A new owner or locale gets a new coordinator, so another account never sees the previous one's data.
  const key = access.mode === 'online' ? `${access.owner.clientId}:${access.owner.subjectToken}:${locale}` : `offline:${locale}`;
  return <Wallet key={key} locale={locale} access={access} draftSelection={draftSelection} />;
}

function Wallet({ locale, access, draftSelection }: { locale: WalletLocale; access: WalletAccess; draftSelection: boolean }) {
  const session = useAuthenticatedSession();
  const [wallet] = useState(() => createPolicyWallet(session.baseUrl, session, access.mode === 'online' ? access.owner : undefined));
  const state = useSyncExternalStore(wallet.subscribe, wallet.getSnapshot, wallet.getSnapshot);
  const { scrollRef, headingRef } = usePageFocus(state.status === 'ready' && state.page !== null ? state.page : undefined);
  const [selected, select] = useState<string>();
  const [documentFailed, setDocumentFailed] = useState(false);
  const copy = walletMessages[locale];
  const now = useNow();
  const [filter, setFilter] = useState<PolicyFilter>('all');
  useEffect(() => {
    void wallet.unlock();
    const lifecycle = AppState.addEventListener('change', next => { if (next !== 'active') { select(undefined); wallet.lock(); } });
    return () => { lifecycle.remove(); wallet.lock(); };
  }, [wallet]);
  const policy = state.status === 'ready' ? state.policies.find(item => item.policyId === selected) : undefined;
  return <SafeAreaView style={styles.safe}>
    <ScrollView ref={scrollRef} contentContainerStyle={styles.content}>
      <View style={styles.page}>
        {access.mode === 'offline' && <Action label={copy.back} secondary onPress={() => router.replace('/')} />}
        <Text ref={headingRef} accessible accessibilityRole="header" style={styles.title}>{draftSelection ? copy.chooseDraftPolicy : copy.title}</Text>
        {draftSelection && <Text style={styles.body}>{copy.chooseDraftHint}</Text>}
        {state.status === 'locked' && <Locked state={state} locale={locale} onUnlock={() => void wallet.unlock()} />}
        {state.status === 'loading' && <ActivityIndicator accessibilityLabel={copy.loading} color={theme.colors.primary} />}
        {state.status === 'failed' && <>
          <Text accessibilityRole="alert" style={styles.notice}>{copy.failures[state.failure]}</Text>
          {state.failure !== 'unauthorized' && <Action label={copy.retry} onPress={() => void wallet.refresh()} />}
        </>}
        {state.status === 'ready' && <>
          <SourceBanner state={state} locale={locale} unverified={access.mode === 'offline'} />
          {documentFailed && <Text accessibilityRole="alert" style={styles.notice}>{copy.documentFailed}</Text>}
          {policy ? <Detail policy={policy} state={state} locale={locale} now={now} onBack={() => select(undefined)} onOpenDocuments={() => {
            setDocumentFailed(false);
            const destination = new URL('/polizas', session.baseUrl);
            destination.hash = new URLSearchParams({ policy: policy.policyId, section: 'documents' }).toString();
            void Linking.openURL(destination.toString()).catch(() => setDocumentFailed(true));
          }} />
            : <List state={state} locale={locale} now={now} draftSelection={draftSelection} filter={filter} onFilter={setFilter} onOpen={policyId => {
              if (draftSelection) router.replace({ pathname: '/claim-drafts', params: { policyId } });
              else select(policyId);
            }} />}
          {!policy && state.source === 'online' && state.page !== null && <PolicyPages page={state.page} hasMore={state.hasMore} locale={locale}
            onPrevious={() => void wallet.previousPage()} onNext={() => void wallet.nextPage()} />}
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
    {!stored && state.stored && <Text style={styles.caption}>{copy.offlinePage}</Text>}
  </View>;
}

function List({ state, locale, now, onOpen, draftSelection, filter, onFilter }: { state: Ready; locale: WalletLocale; now: number; onOpen: (policyId: string) => void;
  draftSelection: boolean; filter: PolicyFilter; onFilter(value: PolicyFilter): void }) {
  const copy = walletMessages[locale];
  const available = draftSelection ? state.policies.filter(policy => isReportableProduct(policy.product) && validityAt(policy, now) === 'active') : state.policies;
  if (available.length === 0) return <Text style={styles.body}>{draftSelection ? copy.noDraftPolicies : (state.page ?? 1) > 1 ? copy.emptyPage : copy.empty}</Text>;
  const sorted = available.filter(policy => draftSelection || filter === 'all' || validityAt(policy, now) === filter)
    .sort((a, b) => Date.parse(b.effectiveUntil) - Date.parse(a.effectiveUntil));
  return <View style={styles.section}>
    {!draftSelection && <View style={styles.filters}>
      {(['active', 'expired', 'all'] as const).map(value => <Pressable key={value} accessibilityRole="button"
        accessibilityState={{ selected: value === filter }} onPress={() => onFilter(value)}
        style={[styles.filter, value === filter && styles.filterSelected]}>
        <Text style={[styles.filterText, value === filter && styles.filterTextSelected]}>{copy.filters[value]}</Text>
      </Pressable>)}
    </View>}
    {sorted.length === 0 && <Text style={styles.body}>{copy.emptyFilter}</Text>}
    {sorted.map(policy => {
      const validity = validityAt(policy, now);
      return <Pressable key={policy.policyId} accessibilityRole="button" onPress={() => onOpen(policy.policyId)}
        style={({ pressed }) => [styles.item, pressed && styles.dimmed]}>
        <View style={styles.itemHeading}>
          <Text style={styles.itemTitle}>{copy.products[policy.product]}</Text>
          <Text style={[styles.badge, validity !== 'active' && styles.badgeNeutral]}>{copy.validity[validity]}</Text>
        </View>
        <View style={styles.facts}>
          <Fact label={copy.fields.reference} value={policyReference(policy.policyId)} />
          <Fact label={copy.fields.premium} value={formatMoney(policy.premium, locale)} />
          <Fact label={copy.fields.until} value={formatDate(policy.effectiveUntil, locale)} />
        </View>
        {state.stored && <Text style={styles.caption}>{copy.availableOffline}</Text>}
      </Pressable>;
    })}
  </View>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <View style={styles.fact}>
    <Text style={styles.caption}>{label}</Text>
    <Text style={styles.factValue}>{value}</Text>
  </View>;
}

function Detail({ policy, state, locale, now, onBack, onOpenDocuments }: { policy: CachedPolicy; state: Ready; locale: WalletLocale; now: number; onBack: () => void; onOpenDocuments: () => void }) {
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
      : coverage.kind === 'flight_delay'
        ? <>
          <Row label={copy.coverages.threshold} value={`${coverage.thresholdMinutes} ${copy.coverages.minutes}`} />
          <Row label={copy.coverages.payout} value={formatMoney(coverage.payoutAmount, locale)} />
          <Row label={copy.coverages.flight} value={coverage.flightReference.slice(0, 8).toUpperCase()} />
        </>
        : <>
          <Row label={copy.coverages.rainThreshold} value={`${coverage.threshold} ${coverage.unit}`} />
          <Row label={copy.coverages.payout} value={formatMoney(coverage.payoutAmount, locale)} />
          <Row label={copy.coverages.station} value={coverage.stationId.slice(0, 8).toUpperCase()} />
        </>}
    <Text style={styles.caption}>{copy.document}</Text>
    {state.source === 'online' && <Pressable accessibilityRole="link" onPress={onOpenDocuments} style={({ pressed }) => [styles.button, styles.secondary, pressed && styles.dimmed]}>
      <Text style={[styles.buttonText, styles.secondaryText]}>{copy.openDocuments}</Text></Pressable>}
    <Action label={copy.saveDraft} secondary onPress={() => router.push({ pathname: '/claim-drafts', params: { policyId: policy.policyId } })} />
    {/* A report needs the server, so a stored copy never offers it. */}
    {state.source !== 'stored' && isReportableProduct(policy.product) && validityAt(policy, now) === 'active'
      && <Action label={copy.reportClaim} onPress={() => router.push({ pathname: '/claim-report', params: { policyId: policy.policyId } })} />}
  </View>;
}

function Row({ label, value }: { label: string; value: string }) {
  const { width, fontScale } = useWindowDimensions();
  return <View style={[styles.row, (width < 380 || fontScale > 1.2) && styles.stackedRow]}>
    <Text style={styles.body}>{label}</Text><Text style={styles.value}>{value}</Text></View>;
}

function Action({ label, secondary = false, onPress }: { label: string; secondary?: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.button, secondary && styles.secondary, pressed && styles.dimmed]}>
    <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background }, content: { padding: 24, paddingVertical: 32 },
  card: { width: '100%', maxWidth: 480, alignSelf: 'center', padding: 24, borderRadius: 28, backgroundColor: theme.colors.surface, gap: 18 },
  page: { width: '100%', maxWidth: 520, alignSelf: 'center', gap: 16 },
  title: { fontSize: 32, lineHeight: 38, color: theme.colors.foreground, fontWeight: '700', letterSpacing: -0.8 },
  subtitle: { fontSize: 18, lineHeight: 26, color: theme.colors.foreground, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 23, color: theme.colors.foreground, flexShrink: 1 }, caption: { fontSize: 12, lineHeight: 18, color: theme.colors.muted },
  notice: { padding: 14, borderRadius: 14, backgroundColor: theme.colors.warningSurface, color: theme.colors.warningText, fontSize: 14, lineHeight: 21 },
  section: { gap: 12 },
  banner: { padding: 14, borderRadius: 14, backgroundColor: theme.colors.mint, gap: 4 },
  bannerStored: { backgroundColor: theme.colors.warningSurface },
  bannerLabel: { fontSize: 12, lineHeight: 18, fontWeight: '700', letterSpacing: 0.6, color: theme.colors.onMint },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  filter: { paddingHorizontal: 16, minHeight: 48, borderRadius: 24, backgroundColor: theme.colors.border, justifyContent: 'center' },
  filterSelected: { backgroundColor: theme.colors.primaryDark },
  filterText: { fontSize: 14, color: theme.colors.foreground, fontWeight: '600' },
  filterTextSelected: { color: theme.colors.onPrimary },
  item: { padding: 18, backgroundColor: theme.colors.surface, borderRadius: 24, gap: 12, minHeight: 48 },
  itemHeading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  badge: { color: theme.colors.onMint, backgroundColor: theme.colors.mint, borderRadius: 12, paddingHorizontal: 9,
    paddingVertical: 4, fontSize: 12, fontWeight: '700' },
  badgeNeutral: { color: theme.colors.muted, backgroundColor: theme.colors.background },
  facts: { borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 12, flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  fact: { flexGrow: 1, flexBasis: '45%', minWidth: 120, gap: 2 },
  factValue: { color: theme.colors.foreground, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  itemTitle: { fontSize: 17, lineHeight: 24, fontWeight: '600', color: theme.colors.foreground },
  credential: { padding: 16, borderRadius: 16, backgroundColor: theme.colors.mint, gap: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 6, borderBottomWidth: 1, borderColor: theme.colors.border },
  stackedRow: { flexDirection: 'column', gap: 4 },
  value: { fontSize: 15, lineHeight: 23, fontWeight: '600', color: theme.colors.foreground },
  button: { minHeight: 54, backgroundColor: theme.colors.primaryDark, borderRadius: 16, padding: 16, justifyContent: 'center' },
  secondary: { backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border },
  buttonText: { fontSize: 15, lineHeight: 22, fontWeight: '600', textAlign: 'center', color: theme.colors.onPrimary }, secondaryText: { color: theme.colors.primaryDark }, dimmed: { opacity: 0.5 },
});
