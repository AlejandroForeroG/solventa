import { router } from 'expo-router';
import React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../../theme';
import { useAuthentication } from '../../authentication/presentation/AuthenticationProvider';
import { useAppMessages } from '../../../shared/i18n/use-app-messages';

export function WelcomeScreen() {
  const auth = useAuthentication();
  const copy = useAppMessages();
  const busy = auth.status === 'loading' || auth.status === 'authorizing' || auth.status === 'biometricPrompt';
  const authenticated = auth.status === 'authenticated';
  const heading = authenticated ? copy.headings.authenticated : auth.status === 'locked' ? copy.headings.locked
    : auth.status === 'blocked' ? copy.headings.blocked : auth.status === 'logoutPending' ? copy.headings.logoutPending
      : auth.status === 'signedOut' ? copy.headings.signedOut : copy.headings.signIn;
  const status = auth.status === 'authorizing' ? copy.authorizing
    : auth.status === 'biometricPrompt' ? copy.biometricPrompt : copy.verifying;

  return (
    <SafeAreaView style={styles.safeArea}>
      <View pointerEvents="none" accessible={false} accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants" style={styles.backgroundShapes}>
        <View style={styles.topSquare} />
        <View style={styles.topOutline} />
        <View style={styles.bottomSquare} />
        <View style={styles.bottomOutline} />
        <View style={styles.smallSquare} />
      </View>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.content}>
          <View style={styles.card}>
            <View style={styles.cardHeading}>
              <Text accessibilityRole="header" style={styles.cardTitle}>{heading}</Text>
            </View>

            {auth.status === 'signedOut' && <Text style={styles.introduction}>
              {copy.introduction}
            </Text>}

            {busy && <View accessibilityLiveRegion="polite" style={styles.progress}>
              <ActivityIndicator accessibilityLabel={status} color={theme.colors.primary} />
              <Text style={styles.progressText}>{status}</Text>
            </View>}
            {auth.failure && auth.failure !== 'biometric_locked' && <View accessibilityLiveRegion="polite" style={styles.notice}>
              <Text style={styles.noticeText}>{copy.failures[auth.failure]}</Text>
            </View>}
            {auth.traceId && <Text selectable style={styles.reference}>{copy.reference}: {auth.traceId}</Text>}

            {auth.status === 'signedOut' && <>
              <Action label={copy.actions.signIn} disabled={Platform.OS === 'web'} onPress={() => void auth.signIn()} />
            </>}
            {auth.status === 'locked' && <>
              <Action label={copy.actions.unlock} onPress={() => void auth.unlock()} />
              <View style={styles.separator}><View style={styles.rule} /><Text style={styles.caption}>{copy.or}</Text><View style={styles.rule} /></View>
              <Action variant="secondary" label={copy.actions.alternative} onPress={() => void auth.signIn()} />
            </>}
            {authenticated && <>
              <Action label={copy.actions.verifyIdentity} onPress={() => router.push('/identity-verification')} />
              {auth.email && <View style={styles.account}><Text style={styles.accountLabel}>{copy.currentAccount}</Text>
                <Text selectable style={styles.email}>{auth.email}</Text></View>}
              <View style={styles.biometricStatus}>
                <Text style={styles.biometricTitle}>{auth.biometricEnabled ? copy.biometricEnabled : copy.biometricSetup}</Text>
                <Text style={styles.description}>{auth.biometricEnabled ? copy.biometricReady : copy.biometricDescription}</Text>
              </View>
              {!auth.biometricEnabled && <>
                <Action label={copy.actions.enable} disabled={!auth.canEnableBiometrics} onPress={() => void auth.enableBiometrics()} />
                {!auth.canEnableBiometrics && <Text style={styles.description}>{copy.primaryRequired}</Text>}
              </>}
              {auth.biometricEnabled && <Action variant="secondary" label={copy.actions.revoke} onPress={() => void auth.revokeDevice()} />}
            </>}
            {auth.status === 'blocked' && <Action label={copy.actions.retry} onPress={() => void auth.retry()} />}
            {auth.status === 'logoutPending' && <>
              <Text style={styles.description}>{copy.pendingLogout}</Text>
              <Action label={copy.actions.retryLogout} onPress={() => void auth.retry()} />
            </>}
            {(authenticated || auth.status === 'blocked') && <Action variant="text" label={copy.actions.signOut} onPress={() => void auth.signOut()} />}
            {auth.status === 'authorizing' && <Action variant="secondary" label={copy.actions.cancel} onPress={() => void auth.cancel()} />}
            {Platform.OS === 'web' && <Text style={styles.description}>{copy.nativeOnly}</Text>}
          </View>

        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Action({ label, onPress, disabled = false, variant = 'primary' }: {
  label: string; onPress: () => void; disabled?: boolean; variant?: 'primary' | 'secondary' | 'text';
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
    onPress={onPress} style={({ pressed }) => [styles.button, variant === 'secondary' && styles.secondaryButton,
      variant === 'text' && styles.textButton, (pressed || disabled) && styles.dimmed]}>
    <Text style={[styles.buttonText, variant !== 'primary' && styles.secondaryButtonText]}>{label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: theme.colors.background },
  backgroundShapes: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, overflow: 'hidden' },
  topSquare: { position: 'absolute', width: 280, height: 280, top: -130, right: -90,
    borderRadius: 64, backgroundColor: theme.colors.mint, opacity: 0.8, transform: [{ rotate: '22deg' }] },
  topOutline: { position: 'absolute', width: 88, height: 88, top: '14%', left: 28,
    borderRadius: 24, borderWidth: 1.5, borderColor: theme.colors.primary, opacity: 0.12, transform: [{ rotate: '-18deg' }] },
  bottomSquare: { position: 'absolute', width: 250, height: 250, bottom: -95, left: -115,
    borderRadius: 64, backgroundColor: theme.colors.mint, opacity: 0.75, transform: [{ rotate: '-22deg' }] },
  bottomOutline: { position: 'absolute', width: 230, height: 230, bottom: -105, right: -70,
    borderRadius: 56, borderWidth: 1.5, borderColor: theme.colors.primary, opacity: 0.12, transform: [{ rotate: '22deg' }] },
  smallSquare: { position: 'absolute', width: 40, height: 40, right: 34, bottom: '18%',
    borderRadius: 12, backgroundColor: theme.colors.primary, opacity: 0.06, transform: [{ rotate: '-18deg' }] },
  scrollContent: { flexGrow: 1, justifyContent: 'center', padding: 24, paddingVertical: 40 },
  content: { width: '100%', maxWidth: 420, alignSelf: 'center', gap: 32 },
  card: { padding: 24, gap: 18, backgroundColor: theme.colors.surface, borderRadius: 28,
    boxShadow: '0 6px 24px rgba(6, 47, 42, 0.04)' },
  cardHeading: { alignItems: 'center', paddingBottom: 6 },
  cardTitle: { color: theme.colors.foreground, fontWeight: '600', fontSize: 23, lineHeight: 30, letterSpacing: -0.5, textAlign: 'center' },
  description: { color: theme.colors.muted, fontSize: 14, lineHeight: 21 },
  introduction: { color: theme.colors.muted, fontSize: 15, lineHeight: 23, textAlign: 'center' },
  progress: { flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 12 },
  progressText: { flex: 1, color: theme.colors.muted, fontSize: 14, lineHeight: 21 },
  notice: { backgroundColor: theme.colors.warningSurface, borderRadius: 14, padding: 16 },
  noticeText: { color: theme.colors.warningText, fontSize: 14, lineHeight: 21 },
  reference: { color: theme.colors.muted, fontSize: 12, lineHeight: 18 },
  caption: { color: theme.colors.muted, textAlign: 'center', fontSize: 13, lineHeight: 20 },
  separator: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  rule: { flex: 1, height: 1, backgroundColor: theme.colors.border },
  account: { gap: 6, paddingTop: 4 },
  accountLabel: { color: theme.colors.muted, fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },
  email: { color: theme.colors.foreground, fontSize: 16, lineHeight: 24 },
  biometricStatus: { backgroundColor: theme.colors.mint, padding: 16, gap: 6, borderRadius: 16 },
  biometricTitle: { color: theme.colors.primaryDark, fontWeight: '600', fontSize: 15, lineHeight: 22 },
  button: { minHeight: 54, paddingVertical: 16, paddingHorizontal: 18, borderRadius: 16,
    backgroundColor: theme.colors.primaryDark, alignItems: 'center', justifyContent: 'center' },
  secondaryButton: { backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border },
  textButton: { backgroundColor: 'transparent', minHeight: 48, paddingVertical: 12 },
  buttonText: { color: theme.colors.onPrimary, fontSize: 15, lineHeight: 22, fontWeight: '600', textAlign: 'center' },
  secondaryButtonText: { color: theme.colors.primaryDark },
  dimmed: { opacity: 0.5 },
});
