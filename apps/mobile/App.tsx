import { StatusBar } from 'expo-status-bar';
import { Image, StyleSheet, Text, View } from 'react-native';
import { assetPaths } from '@solventa/assets';
import { brandAssets } from '@solventa/assets/mobile';

export default function App() {
  return <View style={styles.container}><Image source={brandAssets.logo.green} style={styles.logo} resizeMode="contain" accessible accessibilityLabel="Solventa" /><Text>Aplicación en preparación.</Text><StatusBar style="dark" /></View>;
}

const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', gap: 12 }, logo: { width: 240, aspectRatio: assetPaths.logo.green.aspectRatio } });
