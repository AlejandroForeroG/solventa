import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

export default function App() {
  return <View style={styles.container}><Text accessibilityRole="header">Solventa</Text><Text>Aplicación en preparación.</Text><StatusBar style="dark" /></View>;
}

const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', gap: 12 } });
