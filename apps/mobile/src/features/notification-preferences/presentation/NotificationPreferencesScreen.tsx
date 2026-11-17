import { randomUUID } from 'expo-crypto';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuthenticatedSession, useAuthentication } from '@/features/authentication/presentation/AuthenticationProvider';
import { messages } from '@/shared/i18n/messages';
import { useAppMessages } from '@/shared/i18n/use-app-messages';
import { theme } from '@/theme';
import { createPreferencesApi, PreferencesApiFailure } from '../adapters/preferences-api';
import { openPushSettings, pushPermission, requestPushPermission } from '../adapters/push-permission';
import { categories, channels, withChannel } from '../domain/preferences';
import type { Category, Channel, Matrix, Preferences } from '../domain/preferences';

const copy = {
  es: {
    save: 'Guardar preferencias', saved: 'Preferencias guardadas.',
    retry: 'Reintentar', reload: 'Actualizar', loading: 'Cargando preferencias…',
    signedOut: 'Inicia sesión para consultar tus preferencias.',
    blocked: 'Push no está autorizado por el dispositivo. Actívalo en Ajustes para recibir avisos por este canal.',
    openSettings: 'Abrir Ajustes',
    pending: 'Push está elegido, pero no operará hasta que autorices las notificaciones en el dispositivo.',
    conflict: 'Las preferencias cambiaron en otra sesión. Actualiza antes de guardar.',
    failure: 'No pudimos guardar las preferencias. Reintenta con la misma solicitud o actualiza.',
    readFailure: 'No pudimos cargar tus preferencias.',
    channels: { push: 'Push', email: 'Correo', sms: 'SMS' },
    categories: { policy: ['Eventos de póliza', 'Emisión, renovación y cambios'],
      payments: ['Pagos y primas', 'Débitos y vencimientos'], claims: ['Siniestros', 'Radicación e indemnización'],
      commercial: ['Novedades comerciales', 'Productos y beneficios'] },
  },
  en: {
    save: 'Save preferences', saved: 'Preferences saved.',
    retry: 'Retry', reload: 'Refresh', loading: 'Loading preferences…',
    signedOut: 'Sign in to view your preferences.',
    blocked: 'Push is blocked by your device. Enable notifications in Settings to receive this channel.',
    openSettings: 'Open Settings',
    pending: 'Push is selected but cannot operate until you allow notifications on this device.',
    conflict: 'Preferences changed in another session. Refresh before saving.',
    failure: 'We could not save your preferences. Retry the same request or refresh.',
    readFailure: 'We could not load your preferences.',
    channels: { push: 'Push', email: 'Email', sms: 'SMS' },
    categories: { policy: ['Policy events', 'Issuance, renewal and changes'],
      payments: ['Payments and premiums', 'Debits and due dates'], claims: ['Claims', 'Filing and indemnity'],
      commercial: ['Commercial news', 'Products and benefits'] },
  },
} as const;

export function NotificationPreferencesScreen() {
  const auth = useAuthentication();
  const language = useAppMessages() === messages.en ? 'en' : 'es';
  const text = copy[language];
  if (auth.status !== 'authenticated' || !auth.principal) return <SafeAreaView style={styles.safe} edges={['left', 'right', 'bottom']}>
    <View style={styles.content}><View style={styles.panel}>
      <Text style={styles.description}>{text.signedOut}</Text>
    </View></View>
  </SafeAreaView>;
  return <PreferencesFlow key={`${auth.principal.clientId}:${auth.principal.subjectToken}`} language={language} />;
}

function PreferencesFlow({ language }: { language: 'es' | 'en' }) {
  const text = copy[language];
  const { width, fontScale } = useWindowDimensions();
  const stacked = fontScale > 1.2 || width < 380;
  const session = useAuthenticatedSession();
  const [api] = useState(() => createPreferencesApi(session.baseUrl, session));
  const [saved, setSaved] = useState<Preferences>();
  const [draft, setDraft] = useState<Matrix>();
  const [permission, setPermission] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'read' | 'save' | 'conflict'>();
  const [notice, setNotice] = useState(false);
  const [pending, setPending] = useState<{ matrix: Matrix; version: number; key: string }>();

  const refresh = useCallback(async () => {
    setBusy(true); setError(undefined); setPending(undefined); setNotice(false);
    const permissionCheck = pushPermission().then(setPermission).catch(() => setPermission(false));
    try {
      const value = await api.read();
      setSaved(value); setDraft(value.preferences);
    } catch { setSaved(undefined); setDraft(undefined); setError('read'); }
    finally { await permissionCheck; setBusy(false); }
  }, [api]);
  useEffect(() => { void Promise.resolve().then(refresh);
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') {
        setPermission(null);
        void pushPermission().then(setPermission).catch(() => setPermission(false));
      }
    });
    return () => listener.remove();
  }, [refresh]);

  async function toggle(category: Category, channel: Channel, enabled: boolean) {
    if (!draft || pending) return;
    setDraft(withChannel(draft, category, channel, enabled)); setNotice(false);
    if (channel === 'push' && enabled) {
      try { setPermission(await requestPushPermission()); } catch { setPermission(false); }
    }
  }
  async function save(command = pending ?? (saved && draft ? { matrix: draft, version: saved.version, key: randomUUID() } : undefined)) {
    if (!command || busy) return;
    setBusy(true); setError(undefined); setNotice(false); setPending(command);
    try {
      await api.save(command.matrix, command.version, command.key);
      const current = await api.read();
      setSaved(current); setDraft(current.preferences); setPending(undefined); setNotice(true);
      setPermission(await pushPermission().catch(() => false));
    } catch (cause) { setError(cause instanceof PreferencesApiFailure && cause.code === 'conflict' ? 'conflict' : 'save'); }
    finally { setBusy(false); }
  }
  const pushSelected = !!draft && categories.some(category => draft[category].push);
  const changed = !!saved && !!draft && JSON.stringify(saved.preferences) !== JSON.stringify(draft);
  return <SafeAreaView style={styles.safe} edges={['left', 'right', 'bottom']}><ScrollView contentContainerStyle={styles.content}>
    {busy && <ActivityIndicator accessibilityLabel={text.loading} color={theme.colors.primary} />}
    {error && <View accessibilityLiveRegion="polite" style={styles.warning}><Text style={styles.warningText}>
      {error === 'conflict' ? text.conflict : error === 'read' ? text.readFailure : text.failure}</Text></View>}
    {notice && <Text accessibilityLiveRegion="polite" style={styles.success}>{text.saved}</Text>}
    {permission === false && <View style={[styles.warning, styles.permission]}>
      <Text style={styles.warningText}>{text.blocked}</Text>
      <Action label={text.openSettings} secondary onPress={() => void openPushSettings()} />
    </View>}
    {draft && <View style={styles.panel}>
      {!stacked && <View style={styles.channelHeader}><View style={styles.categoryLabel} />{channels.map(channel =>
        <Text key={channel} style={styles.channelLabel}>{text.channels[channel]}</Text>)}</View>}
      {categories.map(category => <View key={category} style={[styles.row, stacked && styles.stackedRow]}>
        <View style={!stacked && styles.categoryLabel}><Text style={styles.rowTitle}>{text.categories[category][0]}</Text>
          <Text style={styles.caption}>{text.categories[category][1]}</Text></View>
        <View style={[styles.channelControls, stacked && styles.stackedControls]}>
        {channels.map(channel => <Pressable key={channel} style={[styles.switchCell,
          stacked && { flexGrow: 1, flexBasis: Math.max(72, Math.ceil(36 * fontScale)), width: 'auto', gap: 8, paddingVertical: 8 }]}
          accessibilityRole="switch" accessibilityLabel={`${text.categories[category][0]} · ${text.channels[channel]}`}
          accessibilityState={{ checked: draft[category][channel], disabled: busy || !!pending }} disabled={busy || !!pending}
          onPress={() => void toggle(category, channel, !draft[category][channel])}>
          {stacked && <Text accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
            style={styles.stackedChannelLabel}>{text.channels[channel]}</Text>}
          <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
            style={[styles.switchTrack, draft[category][channel] && styles.switchTrackOn, (busy || !!pending) && styles.dimmed]}>
            <View style={[styles.switchThumb, draft[category][channel] && styles.switchThumbOn]} />
          </View></Pressable>)}</View>
      </View>)}
    </View>}
    {pushSelected && permission === false && <Text accessibilityLiveRegion="polite" style={styles.warningText}>{text.pending}</Text>}
    {pending && error === 'save' ? <Action label={text.retry} disabled={busy} onPress={() => void save(pending)} />
      : <Action label={text.save} disabled={busy || !changed || !!pending} onPress={() => void save()} />}
    <Action label={text.reload} secondary disabled={busy} onPress={() => void refresh()} />
  </ScrollView></SafeAreaView>;
}

function Action({ label, onPress, disabled = false, secondary = false }: {
  label: string; onPress: () => void; disabled?: boolean; secondary?: boolean;
}) { return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
  style={[styles.action, secondary && styles.secondary, disabled && styles.dimmed]}>
  <Text style={[styles.actionText, secondary && styles.secondaryText]}>{label}</Text></Pressable>; }

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: 20, gap: 18, paddingBottom: 40 },
  description: { color: theme.colors.muted, fontSize: 14, lineHeight: 21 },
  panel: { backgroundColor: theme.colors.surface, borderRadius: 22, padding: 16, gap: 10 },
  permission: { gap: 12 },
  warning: { backgroundColor: theme.colors.warningSurface, padding: 16, borderRadius: 16 },
  warningText: { color: theme.colors.warningText, fontSize: 14, lineHeight: 21 },
  success: { color: theme.colors.onMint, fontWeight: '600' },
  channelHeader: { flexDirection: 'row', alignItems: 'center', paddingBottom: 8 },
  categoryLabel: { flex: 1, minWidth: 0, paddingRight: 8 },
  channelLabel: { width: 48, color: theme.colors.muted, fontSize: 11, fontWeight: '700', textAlign: 'center' },
  stackedChannelLabel: { color: theme.colors.muted, fontSize: 11, fontWeight: '700', textAlign: 'center' },
  channelControls: { flexDirection: 'row' },
  stackedControls: { flexWrap: 'wrap', gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderColor: theme.colors.border, minHeight: 82 },
  stackedRow: { flexDirection: 'column', alignItems: 'stretch', paddingVertical: 14, gap: 12 },
  rowTitle: { color: theme.colors.foreground, fontSize: 14, fontWeight: '600' },
  caption: { color: theme.colors.muted, fontSize: 11, lineHeight: 16, paddingTop: 3 },
  switchCell: { width: 48, minHeight: 56, alignItems: 'center', justifyContent: 'center' },
  switchTrack: { width: 44, height: 28, borderRadius: 14, backgroundColor: theme.colors.muted, padding: 4 },
  switchTrackOn: { backgroundColor: theme.colors.primary },
  switchThumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: theme.colors.surface, alignSelf: 'flex-start' },
  switchThumbOn: { alignSelf: 'flex-end' },
  action: { backgroundColor: theme.colors.primaryDark, borderRadius: 14, minHeight: 48, justifyContent: 'center', alignItems: 'center', padding: 10 },
  secondary: { backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border },
  actionText: { color: theme.colors.onPrimary, fontSize: 14, fontWeight: '600' },
  secondaryText: { color: theme.colors.primaryDark },
  dimmed: { opacity: 0.5 },
});
