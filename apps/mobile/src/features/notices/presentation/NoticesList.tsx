import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { theme } from '@/theme';
import { useNotices } from './NoticeProvider';
import { useNoticeMessages } from './notice-messages';

// The alerts of the signed-in customer: what the server offered, and what this device did with it.
export function NoticesList() {
  const { center, snapshot } = useNotices();
  const copy = useNoticeMessages();
  if (snapshot.status === 'loading' || snapshot.status === 'idle') return <View style={styles.card}><Text style={styles.detail}>{copy.loading}</Text></View>;
  return <View style={styles.list}>
    {snapshot.status === 'failed' ? <View style={styles.card} accessibilityRole="alert">
      <Text style={styles.detail}>{copy.failed}</Text>
      <Pressable accessibilityRole="button" onPress={() => { void center.refresh(); }} style={styles.action}><Text style={styles.actionText}>{copy.retry}</Text></Pressable>
    </View> : null}
    {snapshot.notices.length === 0 && snapshot.status === 'ready' ? <View style={styles.card}><Text style={styles.detail}>{copy.empty}</Text></View> : null}
    {snapshot.notices.map(notice => <View key={notice.eventId} style={styles.card}>
      <Text style={styles.title}>{copy.kind[notice.kind]}</Text>
      <Text style={styles.detail}>{copy.state[notice.state]} · {new Date(notice.occurredAt).toLocaleString()}</Text>
      <Pressable accessibilityRole="button" onPress={() => router.navigate({ pathname: '/notice-action', params: { eventId: notice.eventId } })} style={styles.action}><Text style={styles.actionText}>{copy.open}</Text></Pressable>
    </View>)}
  </View>;
}

const styles = StyleSheet.create({
  list: { gap: 12 },
  card: { padding: 20, borderRadius: 24, backgroundColor: theme.colors.surface, gap: 8 },
  title: { color: theme.colors.foreground, fontSize: 17, fontWeight: '700' },
  detail: { color: theme.colors.muted, fontSize: 14, lineHeight: 20 },
  action: { alignSelf: 'flex-start', paddingVertical: 8 },
  actionText: { color: theme.colors.foreground, fontSize: 14, fontWeight: '700', textDecorationLine: 'underline' },
});
