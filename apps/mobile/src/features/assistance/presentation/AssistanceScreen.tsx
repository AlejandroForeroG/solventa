import type { AssistanceProviderMatch, AssistanceSearchRequest } from '@solventa/contracts';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { messages } from '../../../shared/i18n/messages';
import { useAppMessages } from '../../../shared/i18n/use-app-messages';
import { theme } from '../../../theme';
import { useAuthenticatedSession, useAuthentication } from '../../authentication/presentation/AuthenticationProvider';
import { createAssistanceApi } from '../adapters/assistance-api';
import { readDeviceLocation, requestDeviceLocationPermission } from '../adapters/device-location';

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

type Result = { state: 'idle' | 'denied' | 'locationError' | 'unavailable' }
  | { state: 'ready'; providers: AssistanceProviderMatch[] };
type Search = Extract<AssistanceSearchRequest, { kind: 'manual' }>
  | { kind: 'nearby'; permission: Promise<boolean | null> };

export function AssistanceScreen() {
  const auth = useAuthentication();
  const appCopy = useAppMessages();
  const english = appCopy === messages.en;
  const copy = english ? en : es;
  const authenticated = auth.status === 'authenticated' && Boolean(auth.principal);
  const verifying = auth.status === 'loading';
  const [previousOwner, setPreviousOwner] = useState<string | null>(null);
  const owner = authenticated && auth.principal
    ? JSON.stringify([auth.principal.clientId, auth.principal.subjectToken]) : verifying ? previousOwner : null;
  if (owner !== previousOwner) setPreviousOwner(owner);

  return <SafeAreaView style={styles.safe} edges={['left', 'right', 'bottom']}>
    {owner && <Directory key={owner} authenticated={authenticated} copy={copy} locale={english ? 'en-US' : 'es-CO'} />}
    {!authenticated && <Text style={styles.signedOut} accessibilityLiveRegion="polite">
      {verifying ? appCopy.verifying : auth.status === 'blocked' ? appCopy.failures[auth.failure ?? 'unavailable'] : copy.signIn}
    </Text>}
  </SafeAreaView>;
}

function Directory({ authenticated, copy, locale }: { authenticated: boolean; copy: typeof es; locale: string }) {
  const { baseUrl, execute } = useAuthenticatedSession();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<Result>({ state: 'idle' });
  const [search, setSearch] = useState<Search | null>(null);
  if (!authenticated) {
    if (query) setQuery('');
    if (result.state !== 'idle') setResult({ state: 'idle' });
    if (search?.kind === 'manual') setSearch(null);
  }

  useEffect(() => {
    if (!authenticated || !search) return;
    const controller = new AbortController();
    const { signal } = controller;
    const finish = (next: Result) => {
      if (signal.aborted) return;
      setResult(next);
      setSearch(null);
    };
    async function lookup(request: Search) {
      let input: AssistanceSearchRequest;
      if (request.kind === 'nearby') {
        // Android's permission activity can pause the app. Reuse its answer after session revalidation.
        const permission = await request.permission;
        if (signal.aborted) return;
        if (!permission) return finish({ state: permission === null ? 'locationError' : 'denied' });
        const coordinates = await readDeviceLocation(signal).catch(() => null);
        if (signal.aborted) return;
        if (!coordinates) return finish({ state: 'locationError' });
        input = { kind: 'nearby', locationAuthorized: true, coordinates };
      } else {
        input = request;
      }
      const providers = await createAssistanceApi(baseUrl, { execute }).search(input, signal);
      finish({ state: 'ready', providers });
    }
    void lookup(search).catch(() => finish({ state: 'unavailable' }));
    return () => controller.abort();
  }, [authenticated, baseUrl, execute, search]);

  function searchByLocation() {
    const permission = requestDeviceLocationPermission().catch(() => null);
    setResult({ state: 'idle' });
    setSearch({ kind: 'nearby', permission });
  }

  function searchManually() {
    const place = query.trim();
    if (place.length < 2) return;
    setResult({ state: 'idle' });
    setSearch({ kind: 'manual', query: place });
  }

  if (!authenticated) return null;
  const busy = search !== null;
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
    <Text style={styles.demo}>{copy.demo}</Text>
    <View style={styles.card}>
      <Text style={styles.detail}>{copy.purpose}</Text>
      <Action label={copy.location} onPress={searchByLocation} disabled={busy} />
      <Text style={styles.title}>{copy.manual}</Text>
      <TextInput accessibilityLabel={copy.manual} style={styles.input} placeholder={copy.placeholder}
        placeholderTextColor={theme.colors.muted} value={query} maxLength={160} returnKeyType="search"
        onChangeText={setQuery} onSubmitEditing={searchManually} />
      <Action label={copy.search} onPress={searchManually} disabled={query.trim().length < 2} />
    </View>
    {busy && <ActivityIndicator color={theme.colors.primary} accessibilityLabel={copy.loading} />}
    {result.state !== 'idle' && result.state !== 'ready'
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
