import { router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { theme } from '../../../theme';
import { useAppMessages } from '../../../shared/i18n/use-app-messages';
import { useAuthenticatedSession, useAuthentication } from '../../authentication/presentation/AuthenticationProvider';
import { createNoticesApi } from '../adapters/notices-api';
import { clearNoticeLogin, rememberNoticeLogin } from '../application/login-destination';
import { destinationUrl } from '../domain/destination';
import { uuid } from '../domain/notice';
import { useNoticeMessages } from './notice-messages';

export function NoticeActionScreen() {
  const { eventId } = useLocalSearchParams<{ eventId?: string | string[] }>();
  const auth = useAuthentication();
  const appCopy = useAppMessages();
  const copy = useNoticeMessages();
  return <SafeAreaView style={styles.safe}><View style={styles.card}>
    <Text accessibilityRole="header" style={styles.title}>{copy.title}</Text>
    {auth.status !== 'authenticated' && <>
      <Text style={styles.body}>{auth.failure ? appCopy.failures[auth.failure] : auth.status === 'authorizing' ? appCopy.authorizing : auth.status === 'loading' ? appCopy.verifying : copy.signIn}</Text>
      {auth.status === 'signedOut' && uuid(eventId) && <Pressable accessibilityRole="button" style={styles.action} onPress={() => { rememberNoticeLogin(eventId); void auth.signIn(); }}><Text style={styles.label}>{appCopy.actions.signIn}</Text></Pressable>}
      {auth.status === 'authorizing' && <Pressable accessibilityRole="button" style={styles.action} onPress={() => void auth.cancel()}><Text style={styles.label}>{appCopy.actions.cancel}</Text></Pressable>}
      {auth.status === 'blocked' && <Pressable accessibilityRole="button" style={styles.action} onPress={() => void auth.retry()}><Text style={styles.label}>{copy.retry}</Text></Pressable>}
      {auth.status === 'locked' && <Pressable accessibilityRole="button" style={styles.action} onPress={() => void auth.unlock()}><Text style={styles.label}>{copy.retry}</Text></Pressable>}
    </>}
    {!uuid(eventId) && <Text accessibilityRole="alert" style={styles.body}>{copy.actionFailed}</Text>}
    {auth.status === 'authenticated' && auth.principal && uuid(eventId) && <OpenNotice key={`${auth.principal.clientId}:${auth.principal.subjectToken}:${eventId}`} eventId={eventId} />}
    <Pressable accessibilityRole="button" style={styles.action} onPress={() => { clearNoticeLogin(); router.replace('/alerts'); }}><Text style={styles.label}>{copy.back}</Text></Pressable>
  </View></SafeAreaView>;
}

function OpenNotice({ eventId }: { eventId: string }) {
  const session = useAuthenticatedSession();
  const copy = useNoticeMessages();
  const [state, setState] = useState<'idle' | 'opening' | 'failed'>('idle');
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function open() {
    if (state === 'opening') return;
    setState('opening');
    try {
      const destination = await createNoticesApi(session.baseUrl, session).destination(eventId);
      if (!active.current) return;
      await Linking.openURL(destinationUrl(session.baseUrl, destination));
      if (active.current) setState('idle');
    } catch { if (active.current) setState('failed'); }
  }
  return <>
    {state === 'failed' && <Text accessibilityRole="alert" style={styles.body}>{copy.actionFailed}</Text>}
    {state === 'opening' && <ActivityIndicator accessibilityLabel={copy.opening} color={theme.colors.primary} />}
    <Pressable accessibilityRole="button" disabled={state === 'opening'} style={styles.action} onPress={() => void open()}><Text style={styles.label}>{state === 'failed' ? copy.retry : copy.open}</Text></Pressable>
  </>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background, padding: 20 },
  card: { padding: 20, borderRadius: 24, backgroundColor: theme.colors.surface, gap: 16 },
  title: { color: theme.colors.foreground, fontSize: 24, fontWeight: '700' },
  body: { color: theme.colors.muted, fontSize: 16, lineHeight: 24 },
  action: { paddingVertical: 12 },
  label: { color: theme.colors.foreground, fontSize: 16, fontWeight: '700', textDecorationLine: 'underline' },
});
