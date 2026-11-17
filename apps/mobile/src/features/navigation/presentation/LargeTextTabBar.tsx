import type { ComponentProps } from 'react';
import type { Tabs } from 'expo-router';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme } from '@/theme';

type Props = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

export function LargeTextTabBar({ state, descriptors, navigation }: Props) {
  const { width, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const itemWidth = Math.min(width, Math.max(104, Math.ceil(66 * fontScale)));

  return <View accessibilityRole="tablist" style={[styles.bar, { paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }]}>
    {state.routes.map((route, index) => {
      const { options } = descriptors[route.key];
      const focused = state.index === index;
      const title = options.title ?? route.name;
      const color = focused ? theme.colors.primaryDark : theme.colors.muted;
      return <Pressable key={route.key} accessibilityRole="tab" accessibilityLabel={options.tabBarAccessibilityLabel ?? title}
        accessibilityState={{ selected: focused }}
        onPress={() => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
        }}
        onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
        style={({ pressed }) => [styles.item, { flexBasis: itemWidth, minHeight: Math.max(72, 40 + 15 * fontScale) }, focused && styles.selected, pressed && styles.pressed]}>
        {options.tabBarIcon?.({ focused, color, size: 24 })}
        <Text style={[styles.label, { color }]}>{title}</Text>
      </Pressable>;
    })}
  </View>;
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', flexWrap: 'wrap', borderTopWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
  item: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 8 },
  selected: { backgroundColor: theme.colors.mint },
  pressed: { opacity: 0.7 },
  label: { fontSize: 11, lineHeight: 15, fontWeight: '600', textAlign: 'center' },
});
