import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';
import { useState } from 'react';
import type { Tabs } from 'expo-router';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme } from '@/theme';
import { useNavigationMessages } from './navigation-messages';

type Props = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

export function LargeTextTabBar({ state, descriptors, navigation }: Props) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const copy = useNavigationMessages();
  const current = state.routes[state.index];
  const options = descriptors[current.key].options;
  const title = options.title ?? current.name;

  return <>
    <View style={[styles.bar, { paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${copy.openNavigation} · ${title}`}
        accessibilityState={{ expanded: open }} onPress={() => setOpen(true)} style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}>
        {options.tabBarIcon?.({ focused: true, color: theme.colors.primaryDark, size: 24 })}
        <View style={styles.triggerText}><Text style={styles.caption}>{copy.sections}</Text><Text style={styles.label}>{title}</Text></View>
        <Ionicons accessible={false} name="chevron-up" size={24} color={theme.colors.primaryDark} />
      </Pressable>
    </View>
    <Modal visible={open} animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={() => setOpen(false)}>
      <SafeAreaView style={styles.sheet}>
        <View style={styles.heading}><Text accessibilityRole="header" style={styles.title}>{copy.sections}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={copy.closeNavigation} onPress={() => setOpen(false)} style={styles.close}>
            <Ionicons accessible={false} name="close" size={28} color={theme.colors.primaryDark} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.destinations}>
          {state.routes.map((route, index) => {
            const item = descriptors[route.key].options;
            const focused = state.index === index;
            const label = item.title ?? route.name;
            const color = focused ? theme.colors.primaryDark : theme.colors.foreground;
            return <Pressable key={route.key} accessibilityRole="button" accessibilityLabel={item.tabBarAccessibilityLabel ?? label}
              accessibilityState={{ selected: focused }}
              onPress={() => {
                setOpen(false);
                const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
                if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
              }}
              onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
              style={({ pressed }) => [styles.destination, focused && styles.selected, pressed && styles.pressed]}>
              {item.tabBarIcon?.({ focused, color, size: 24 })}
              <Text style={[styles.destinationLabel, { color }]}>{label}</Text>
              {focused && <Ionicons accessible={false} name="checkmark" size={24} color={color} />}
            </Pressable>;
          })}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  bar: { borderTopWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
  trigger: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 64, paddingVertical: 8, paddingHorizontal: 20 },
  triggerText: { flex: 1, gap: 2 },
  caption: { fontSize: 11, lineHeight: 15, color: theme.colors.muted },
  label: { fontSize: 16, lineHeight: 22, fontWeight: '600', color: theme.colors.primaryDark },
  sheet: { flex: 1, backgroundColor: theme.colors.background },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 20 },
  title: { flex: 1, fontSize: 24, fontWeight: '700', color: theme.colors.foreground },
  close: { width: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  destinations: { padding: 20, gap: 12, paddingBottom: 32 },
  destination: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, minHeight: 64, borderRadius: 16, backgroundColor: theme.colors.surface },
  destinationLabel: { flex: 1, fontSize: 18, lineHeight: 26, fontWeight: '600' },
  selected: { backgroundColor: theme.colors.mint },
  pressed: { opacity: 0.7 },
});
