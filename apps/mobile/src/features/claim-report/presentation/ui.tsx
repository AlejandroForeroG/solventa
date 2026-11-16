import type { PropsWithChildren } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '@/theme';

export function Action({ label, onPress, secondary, disabled }: { label: string; onPress: () => void; secondary?: boolean; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [ui.button, secondary && ui.secondary, (pressed || disabled) && ui.dimmed]}>
    <Text style={[ui.buttonText, secondary && ui.secondaryText]}>{label}</Text>
  </Pressable>;
}

export function Page({ title, subtitle, children }: PropsWithChildren<{ title: string; subtitle?: string }>) {
  return <SafeAreaView style={ui.safe} edges={['top', 'left', 'right']}>
    <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
      <View style={ui.page}>
        {subtitle && <Text style={ui.caption}>{subtitle}</Text>}
        <Text accessibilityRole="header" style={ui.title}>{title}</Text>
        {children}
      </View>
    </ScrollView>
  </SafeAreaView>;
}

export const ui = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background }, content: { padding: 24, paddingBottom: 48 },
  page: { width: '100%', maxWidth: 520, alignSelf: 'center', gap: 16 },
  title: { fontSize: 30, lineHeight: 36, color: theme.colors.foreground, fontWeight: '700', letterSpacing: -0.6 },
  subtitle: { fontSize: 18, lineHeight: 26, color: theme.colors.foreground, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 23, color: theme.colors.foreground, flexShrink: 1 },
  caption: { fontSize: 12, lineHeight: 18, color: theme.colors.muted },
  notice: { padding: 14, borderRadius: 14, backgroundColor: theme.colors.warningSurface, color: theme.colors.warningText, fontSize: 14, lineHeight: 21 },
  error: { fontSize: 13, lineHeight: 19, color: theme.colors.warningText, fontWeight: '600' },
  section: { gap: 12 }, group: { gap: 8 },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '700', color: theme.colors.foreground, letterSpacing: 0.3 },
  card: { padding: 16, backgroundColor: theme.colors.surface, borderRadius: 20, gap: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 16, minHeight: 44, borderRadius: 22, backgroundColor: theme.colors.border, justifyContent: 'center' },
  chipSelected: { backgroundColor: theme.colors.primaryDark },
  chipText: { fontSize: 14, color: theme.colors.foreground, fontWeight: '600' }, chipTextSelected: { color: theme.colors.onPrimary },
  field: { minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface, paddingHorizontal: 14,
    paddingVertical: 12, fontSize: 15, color: theme.colors.foreground },
  multiline: { minHeight: 120, textAlignVertical: 'top' }, invalid: { borderColor: theme.colors.warningText },
  row: { flexDirection: 'row', gap: 12 }, grow: { flex: 1 },
  picker: { minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface, paddingHorizontal: 14, justifyContent: 'center' },
  pickerText: { fontSize: 15, color: theme.colors.foreground, fontWeight: '600' },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10, backgroundColor: theme.colors.surface, borderRadius: 16 },
  thumb: { width: 56, height: 56, borderRadius: 12, backgroundColor: theme.colors.border, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  thumbText: { fontSize: 11, fontWeight: '700', color: theme.colors.muted, letterSpacing: 0.6 },
  remove: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }, removeText: { fontSize: 22, color: theme.colors.muted },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 8, borderBottomWidth: 1, borderColor: theme.colors.border },
  summaryValue: { fontSize: 15, lineHeight: 22, fontWeight: '600', color: theme.colors.foreground, flexShrink: 1, textAlign: 'right' },
  banner: { padding: 14, borderRadius: 14, backgroundColor: theme.colors.mint, gap: 4 },
  bannerLabel: { fontSize: 12, lineHeight: 18, fontWeight: '700', letterSpacing: 0.6, color: theme.colors.onMint },
  caseNumber: { fontSize: 28, lineHeight: 34, fontWeight: '700', color: theme.colors.foreground, fontVariant: ['tabular-nums'], letterSpacing: 0.4 },
  button: { minHeight: 54, backgroundColor: theme.colors.primaryDark, borderRadius: 16, padding: 16, justifyContent: 'center' },
  secondary: { backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border },
  buttonText: { fontSize: 15, lineHeight: 22, fontWeight: '600', textAlign: 'center', color: theme.colors.onPrimary }, secondaryText: { color: theme.colors.primaryDark }, dimmed: { opacity: 0.5 },
});
