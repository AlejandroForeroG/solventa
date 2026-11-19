import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '@/theme';
import { walletMessages, type WalletLocale } from './messages';

export function PolicyPages({ page, hasMore, onPrevious, onNext, locale }: {
  page: number; hasMore: boolean; onPrevious(): void; onNext(): void; locale: WalletLocale;
}) {
  const copy = walletMessages[locale];
  if (page === 1 && !hasMore) return null;
  const actions = [{ label: copy.previousPage, disabled: page === 1, onPress: onPrevious },
    { label: copy.nextPage, disabled: !hasMore, onPress: onNext }];
  return <View style={styles.section}>
    <Text accessibilityLiveRegion="polite" style={styles.caption}>{copy.page} {page}</Text>
    <View style={styles.actions}>
      {actions.map(({ label, disabled, onPress }) =>
        <Pressable key={label} accessibilityRole="button" accessibilityState={{ disabled }}
          disabled={disabled} onPress={onPress}
          style={({ pressed }) => [styles.button, (pressed || disabled) && styles.dimmed]}>
          <Text style={styles.label}>{label}</Text>
        </Pressable>)}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  section: { gap: 8 }, caption: { fontSize: 14, color: theme.colors.muted },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  button: { flexGrow: 1, flexBasis: 120, minHeight: 54, padding: 14, borderRadius: 16, borderWidth: 1,
    borderColor: theme.colors.border, backgroundColor: theme.colors.surface, justifyContent: 'center', alignItems: 'center' },
  label: { fontSize: 15, color: theme.colors.primaryDark, fontWeight: '600' }, dimmed: { opacity: 0.5 },
});
