import { router } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '@/theme';
import { messages } from '@/shared/i18n/messages';
import { useAppMessages } from '@/shared/i18n/use-app-messages';
import { useAuthenticatedSession, useAuthentication } from '@/features/authentication/presentation/AuthenticationProvider';
import { createIdentityVerification } from '../adapters/create-identity-verification';
import { verificationFixtureAssets } from '../adapters/fixture-assets';
import { verificationSteps } from '../domain/verification';
import type { Fixture, Locale, Step } from '../domain/verification';
import { verificationMessages } from './messages';

export function IdentityVerificationScreen() {
  const auth = useAuthentication();
  const locale: Locale = useAppMessages() === messages.en ? 'en-US' : 'es-CO';
  if (auth.status !== 'authenticated' || !auth.principal) return <SafeAreaView style={styles.safe}>
    <View style={styles.card}><Text style={styles.body}>{verificationMessages[locale].signedOut}</Text>
      <Action label={verificationMessages[locale].back} onPress={() => router.replace('/')} /></View>
  </SafeAreaView>;
  // A new owner/locale gets a new coordinator; stale progress never renders during an effect cleanup.
  return <VerificationFlow key={`${auth.principal.clientId}:${auth.principal.subjectToken}:${locale}`} locale={locale} />;
}
function VerificationFlow({ locale }: { locale: Locale }) {
  const session = useAuthenticatedSession();
  const [flow] = useState(() => createIdentityVerification(session.baseUrl, session, locale));
  const state = useSyncExternalStore(flow.subscribe, flow.getSnapshot, flow.getSnapshot);
  const [accepted, setAccepted] = useState(false);
  const copy = verificationMessages[locale];
  useEffect(() => { flow.activate(); void flow.load(); return () => flow.lock(); }, [flow]);
  const verification = state.verification;
  const inactive = !verification || verification.status === 'expired' || verification.status === 'revoked';
  const disabled = state.busy || state.retryPending || !state.loaded;
  const canEdit = !inactive && verification.retryAllowed && !disabled;
  const error = state.error ? copy.errors[state.error as keyof typeof copy.errors] ?? copy.errors.other : null;
  return <SafeAreaView style={styles.safe}>
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Action label={copy.back} secondary disabled={state.busy} onPress={() => router.replace('/')} />
        <Text accessibilityRole="header" style={styles.title}>{copy.title}</Text>
        <Text style={styles.notice}>{copy.simulated}</Text>
        {state.busy && <ActivityIndicator accessibilityLabel={copy.working} color={theme.colors.primary} />}
        {error && <Text accessibilityRole="alert" style={styles.notice}>{error}</Text>}
        {state.traceId && <Text selectable style={styles.caption}>{copy.reference}: {state.traceId}</Text>}
        {verification && <>
          <Text accessibilityLiveRegion="polite" style={styles.body}>{copy.statuses[verification.status]}</Text>
          <Text style={styles.caption}>{copy.expires}: {new Date(verification.expiresAt).toLocaleString(locale)}</Text>
        </>}
        {inactive && state.terms && <>
          <Text style={styles.body}>{state.terms.wording}</Text>
          <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: accepted, disabled }} disabled={disabled}
            onPress={() => setAccepted(value => !value)} style={styles.checkbox}>
            <Text style={styles.body}>{accepted ? '☑' : '☐'} {copy.consent}</Text>
          </Pressable>
          <Action label={verification ? copy.newAttempt : copy.begin} disabled={disabled || !accepted}
            onPress={() => { setAccepted(false); void flow.grant(accepted); }} />
        </>}
        {!inactive && verification && <>
          {verificationSteps.map(step => <StepSelection key={step} step={step} locale={locale} fixtures={state.fixtures.filter(item => item.step === step)}
            saved={verification.steps.find(item => item.step === step)?.reference} disabled={!canEdit} onSave={fixture => void flow.save(step, fixture)} />)}
          <Action label={copy.evaluate} disabled={!canEdit || verification.steps.length !== 3} onPress={() => void flow.evaluate()} />
          {(verification.assistanceAllowed || verification.assistance) && <>
            {verification.assistance ? <View style={styles.section}><Text style={styles.body}>{copy.assistance}</Text>
              <Text selectable style={styles.caption}>{copy.reference}: {verification.assistance.reference}</Text></View>
              : <Action label={copy.assist} secondary disabled={disabled} onPress={() => void flow.assist()} />}
          </>}
          <Action label={copy.revoke} secondary disabled={state.busy || !state.loaded} onPress={() => void flow.revoke()} />
        </>}
        {state.retryPending && <Action label={copy.resume} disabled={state.busy} onPress={() => void flow.retry()} />}
        <Action label={copy.refresh} secondary disabled={state.busy} onPress={() => void flow.load()} />
      </View>
    </ScrollView>
  </SafeAreaView>;
}
function StepSelection({ step, locale, fixtures, saved, disabled, onSave }: {
  step: Step; locale: Locale; fixtures: Fixture[]; saved?: string; disabled: boolean; onSave: (fixture: Fixture) => void;
}) {
  const [selection, select] = useState<string>();
  const copy = verificationMessages[locale];
  const selected = fixtures.find(item => item.reference === selection);
  const asset = selected && Object.hasOwn(verificationFixtureAssets, selected.reference)
    ? verificationFixtureAssets[selected.reference as keyof typeof verificationFixtureAssets] : undefined;
  return <View style={styles.section}>
    <Text accessibilityRole="header" style={styles.stepTitle}>{copy.steps[step]}</Text>
    {saved && <Text style={styles.caption}>{copy.saved}: {fixtures.find(item => item.reference === saved)?.labels[locale]}</Text>}
    {!disabled && <>
      <Text style={styles.caption}>{copy.choose}</Text>
      {fixtures.map(fixture => <Pressable key={fixture.reference} accessibilityRole="radio" accessibilityState={{ selected: selection === fixture.reference }}
        onPress={() => select(fixture.reference)} style={[styles.option, selection === fixture.reference && styles.selected]}>
        <Text style={styles.body}>{fixture.labels[locale]}</Text>
      </Pressable>)}
      {asset && <Image source={asset} accessibilityLabel={selected!.labels[locale]} resizeMode="contain" style={styles.image} />}
      <Action label={copy.save} secondary disabled={!selected} onPress={() => { if (selected) { onSave(selected); select(undefined); } }} />
    </>}
  </View>;
}
function Action({ label, disabled = false, secondary = false, onPress }: { label: string; disabled?: boolean; secondary?: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, secondary && styles.secondary, (pressed || disabled) && styles.dimmed]}>
    <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{label}</Text>
  </Pressable>;
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background }, content: { padding: 24, paddingVertical: 32 },
  card: { width: '100%', maxWidth: 480, alignSelf: 'center', padding: 24, borderRadius: 28, backgroundColor: theme.colors.surface, gap: 18 },
  title: { fontSize: 23, lineHeight: 30, color: theme.colors.foreground, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 23, color: theme.colors.foreground }, caption: { fontSize: 12, lineHeight: 18, color: theme.colors.muted },
  notice: { padding: 14, borderRadius: 14, backgroundColor: theme.colors.mint, color: theme.colors.primaryDark, fontSize: 14, lineHeight: 21 },
  checkbox: { minHeight: 48, justifyContent: 'center' }, section: { borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 18, gap: 12 },
  stepTitle: { fontSize: 18, fontWeight: '600', color: theme.colors.foreground },
  option: { padding: 14, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, minHeight: 48 }, selected: { borderColor: theme.colors.primaryDark, backgroundColor: theme.colors.mint },
  image: { width: '100%', height: 195 }, button: { minHeight: 54, backgroundColor: theme.colors.primaryDark, borderRadius: 16, padding: 16, justifyContent: 'center' },
  secondary: { backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border },
  buttonText: { fontSize: 15, lineHeight: 22, fontWeight: '600', textAlign: 'center', color: theme.colors.onPrimary }, secondaryText: { color: theme.colors.primaryDark }, dimmed: { opacity: 0.5 },
});
