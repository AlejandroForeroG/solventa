import { Image, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '@/theme';

const appIcon = require('../../../../assets/app-icon.png');

export function WelcomeScreen() {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.content}>
        <Image
          accessibilityIgnoresInvertColors
          accessible={false}
          resizeMode="contain"
          source={appIcon}
          style={styles.icon}
        />
        <Text accessibilityRole="header" style={styles.title}>
          Solventa
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.lg,
    padding: theme.spacing.xl,
  },
  icon: {
    width: 144,
    height: 144,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: 42,
    fontWeight: '700',
    letterSpacing: -1,
    lineHeight: 50,
    textAlign: 'center',
  },
});
