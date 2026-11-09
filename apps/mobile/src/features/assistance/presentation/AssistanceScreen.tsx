import type { AssistanceProviderMatch, AssistanceSearchRequest } from '@solventa/contracts';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuthenticatedSession, useAuthentication } from '@/features/authentication/presentation/AuthenticationProvider';
import { messages } from '@/shared/i18n/messages';
import { useAppMessages } from '@/shared/i18n/use-app-messages';
import { theme } from '@/theme';
import { createAssistanceApi } from '../adapters/assistance-api';
import { readDeviceLocation } from '../adapters/device-location';

const es = {
  title: 'Prestadores cercanos', location: 'Usar mi ubicación', purpose: 'Usaremos tu ubicación para esta búsqueda.',
  manual: 'Ciudad o dirección', placeholder: 'Por ejemplo, Bogotá', search: 'Buscar',
  loading: 'Buscando prestadores…', denied: 'Puedes buscar por ciudad o dirección.',
  locationError: 'No pudimos obtener tu ubicación. Busca por ciudad o dirección.',
  unavailable: 'No pudimos consultar los prestadores. Intenta de nuevo.',
  empty: 'No encontramos prestadores en esa zona.', demo: 'Directorio simulado',
  signIn: 'Inicia sesión para consultar prestadores.',
  contact: 'Contacto de prueba', hours: 'Horario',
  kinds: { workshop: 'Taller', expert: 'Perito', roadside: 'Asistencia vial' },
};
const en: typeof es = {
  title: 'Nearby providers', location: 'Use my location', purpose: 'We will use your location for this search.',
  manual: 'City or address', placeholder: 'For example, Bogotá', search: 'Search',
  loading: 'Finding providers…', denied: 'You can search by city or address.',
  locationError: 'We could not get your location. Search by city or address.',
  unavailable: 'We could not load providers. Try again.',
  empty: 'We found no providers in that area.', demo: 'Simulated directory',
  signIn: 'Sign in to find providers.',
  contact: 'Sample contact', hours: 'Hours',
  kinds: { workshop: 'Workshop', expert: 'Expert', roadside: 'Roadside assistance' },
};

type Result = { state: 'idle' | 'loading' | 'denied' | 'locationError' | 'unavailable' }
  | { state: 'ready'; providers: AssistanceProviderMatch[] };

export function AssistanceScreen() {
  const auth = useAuthentication();
  const english = useAppMessages() === messages.en;
  const copy = english ? en : es;
  return <SafeAreaView style={styles.safe} edges={['left', 'right', 'bottom']}>
    {auth.status === 'authenticated' && auth.principal
      ? <Directory key={auth.principal.clientId} copy={copy} locale={english ? 'en-US' : 'es-CO'} />
      : <Text style={styles.signedOut}>{copy.signIn}</Text>}
  </SafeAreaView>;
}

function Directory({ copy, locale }: { copy: typeof es; locale: string }) {
  const session = useAuthenticatedSession();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<Result>({ state: 'idle' });
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  async function search(byLocation: boolean) {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setResult({ state: 'loading' });
    try {
      let input: AssistanceSearchRequest;
      if (byLocation) {
        const coordinates = await readDeviceLocation(controller.signal).catch(() => undefined);
        if (controller.signal.aborted) return;
        if (!coordinates) { setResult({ state: coordinates === null ? 'denied' : 'locationError' }); return; }
        input = { kind: 'nearby', locationAuthorized: true, coordinates };
      } else {
        input = { kind: 'manual', query: query.trim() };
      }
      const providers = await createAssistanceApi(session.baseUrl, session).search(input, controller.signal);
      if (!controller.signal.aborted) setResult({ state: 'ready', providers });
    } catch {
      if (!controller.signal.aborted) setResult({ state: 'unavailable' });
    }
  }

  const busy = result.state === 'loading';
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
    <Text style={styles.demo}>{copy.demo}</Text>
    <View style={styles.card}>
      <Text style={styles.detail}>{copy.purpose}</Text>
      <Action label={copy.location} onPress={() => void search(true)} disabled={busy} />
      <Text style={styles.title}>{copy.manual}</Text>
      <TextInput accessibilityLabel={copy.manual} style={styles.input} placeholder={copy.placeholder}
        placeholderTextColor={theme.colors.muted} value={query} maxLength={160} returnKeyType="search"
        onChangeText={setQuery} onSubmitEditing={() => { if (query.trim().length >= 2) void search(false); }} />
      <Action label={copy.search} onPress={() => void search(false)} disabled={query.trim().length < 2} />
    </View>
    {busy && <ActivityIndicator color={theme.colors.primary} accessibilityLabel={copy.loading} />}
    {result.state !== 'idle' && result.state !== 'ready' && !busy
      && <Text style={styles.detail} accessibilityLiveRegion="polite">{copy[result.state]}</Text>}
    {result.state === 'ready' && result.providers.length === 0 && <Text style={styles.detail}>{copy.empty}</Text>}
    {result.state === 'ready' && result.providers.map(provider => <View key={provider.id} style={styles.card}>
      <Text style={styles.detail}>{copy.kinds[provider.kind]}{provider.distanceKm === undefined ? ''
        : ` · ${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(provider.distanceKm)} km`}</Text>
      <Text accessibilityRole="header" style={styles.title}>{provider.name}</Text>
      <Text style={styles.detail}>{provider.address}, {provider.city}</Text>
      <Text style={styles.detail}>{copy.contact} · {provider.phone}</Text>
      <Text style={styles.detail}>{copy.hours} · {provider.hours}</Text>
    </View>)}
  </ScrollView>;
}

function Action({ label, onPress, disabled = false }: {
  label: string; onPress: () => void; disabled?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} onPress={onPress} disabled={disabled}
    style={[styles.button, disabled && styles.disabled]}>
    <Text style={styles.buttonLabel}>{label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  page: { padding: 24, gap: 16, width: '100%', maxWidth: 520, alignSelf: 'center' },
  card: { padding: 18, borderRadius: 22, backgroundColor: theme.colors.surface, gap: 10 },
  title: { color: theme.colors.foreground, fontSize: 17, fontWeight: '700' },
  detail: { color: theme.colors.muted, fontSize: 15, lineHeight: 21 },
  demo: { color: theme.colors.onMint, backgroundColor: theme.colors.mint, alignSelf: 'flex-start',
    borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, minHeight: 48,
    paddingHorizontal: 12, color: theme.colors.foreground, fontSize: 16 },
  button: { minHeight: 46, borderRadius: 12, padding: 10, justifyContent: 'center', backgroundColor: theme.colors.primaryDark },
  buttonLabel: { color: theme.colors.onPrimary, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  disabled: { opacity: 0.5 },
  signedOut: { margin: 24, color: theme.colors.muted, fontSize: 15 },
});
