import type { AssistanceProviderMatch, AssistanceSearchRequest } from '@solventa/contracts';
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { messages } from '../../../shared/i18n/messages';
import { useAppMessages } from '../../../shared/i18n/use-app-messages';
import { theme } from '../../../theme';
import { useAuthenticatedSession, useAuthentication } from '../../authentication/presentation/AuthenticationProvider';
import { createAssistanceApi } from '../adapters/assistance-api';
import { createAssistanceRequests } from '../adapters/create-assistance-requests';
import { readDeviceLocation, requestDeviceLocationPermission } from '../adapters/device-location';
import type { RequestFailure, RequestPlace } from '../application/assistance-request-flow';

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
  request: 'Solicitar asistencia', review: 'Revisa tu solicitud', provider: 'Prestador', where: 'Dónde estás',
  device: 'Tu ubicación actual', deviceNote: 'Al confirmar, compartes tu ubicación con esta solicitud.', address: 'Dirección',
  confirm: 'Confirmar solicitud', back: 'Volver', sending: 'Registrando tu solicitud…',
  failures: {
    unavailable: 'No pudimos registrar tu solicitud y no sabemos si quedó guardada. Intenta de nuevo: no se creará una solicitud repetida.',
    unauthorized: 'Tu sesión terminó. Inicia sesión para solicitar asistencia.', forbidden: 'Tu cuenta no puede solicitar asistencia.',
    invalid: 'La solicitud no es válida. Vuelve y búscala de nuevo.', not_found: 'Ese prestador ya no está disponible. Busca de nuevo.',
    conflict: 'No pudimos confirmar esta solicitud. Vuelve y envíala de nuevo.',
  } satisfies Record<RequestFailure, string>,
  doneTitle: 'Solicitud registrada', reference: 'Referencia', status: 'Estado', statuses: { requested: 'Solicitada' },
  simulatedNote: 'El prestador es simulado: tu solicitud queda registrada para seguimiento, sin una confirmación real del prestador.', done: 'Listo',
  mine: 'Mis solicitudes', mineLoading: 'Cargando tus solicitudes…', mineEmpty: 'Aún no tienes solicitudes.', mineFailed: 'No pudimos cargar tus solicitudes.', retry: 'Reintentar',
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
  request: 'Request assistance', review: 'Review your request', provider: 'Provider', where: 'Where you are',
  device: 'Your current location', deviceNote: 'By confirming, you share your location with this request.', address: 'Address',
  confirm: 'Confirm request', back: 'Back', sending: 'Registering your request…',
  failures: {
    unavailable: 'We could not register your request and do not know whether it was saved. Try again: a repeated request will not be created.',
    unauthorized: 'Your session ended. Sign in to request assistance.', forbidden: 'Your account cannot request assistance.',
    invalid: 'The request is not valid. Go back and search again.', not_found: 'That provider is no longer available. Search again.',
    conflict: 'We could not confirm this request. Go back and send it again.',
  },
  doneTitle: 'Request registered', reference: 'Reference', status: 'Status', statuses: { requested: 'Requested' },
  simulatedNote: 'The provider is simulated: your request is registered for follow-up, without a real confirmation from the provider.', done: 'Done',
  mine: 'My requests', mineLoading: 'Loading your requests…', mineEmpty: 'You have no requests yet.', mineFailed: 'We could not load your requests.', retry: 'Retry',
};

type Result = { state: 'idle' | 'denied' | 'locationError' | 'unavailable' }
  | { state: 'ready'; providers: AssistanceProviderMatch[]; place: RequestPlace };
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
  const [requests] = useState(() => createAssistanceRequests(baseUrl, { execute }));
  const own = useSyncExternalStore(requests.subscribe, requests.getSnapshot, requests.getSnapshot);
  useEffect(() => { if (authenticated) void requests.refresh(); }, [authenticated, requests]);
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
      let place: RequestPlace;
      if (request.kind === 'nearby') {
        // Android's permission activity can pause the app. Reuse its answer after session revalidation.
        const permission = await request.permission;
        if (signal.aborted) return;
        if (!permission) return finish({ state: permission === null ? 'locationError' : 'denied' });
        const coordinates = await readDeviceLocation(signal).catch(() => null);
        if (signal.aborted) return;
        if (!coordinates) return finish({ state: 'locationError' });
        input = { kind: 'nearby', locationAuthorized: true, coordinates };
        place = { kind: 'device', latitude: coordinates.latitude, longitude: coordinates.longitude };
      } else {
        input = request;
        place = { kind: 'address', address: request.query };
      }
      const providers = await createAssistanceApi(baseUrl, { execute }).search(input, signal);
      finish({ state: 'ready', providers, place });
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
  const asking = own.request.kind !== 'idle';
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
    <Text style={styles.demo}>{copy.demo}</Text>
    {own.request.kind === 'done' && <View style={styles.card} accessibilityLiveRegion="polite">
      <Text accessibilityRole="header" style={styles.title}>{copy.doneTitle}</Text>
      <Text style={styles.detail}>{copy.reference}</Text>
      <Text accessibilityLabel={`${copy.reference} ${own.request.request.reference}`} style={styles.reference}>{own.request.request.reference}</Text>
      <Text style={styles.detail}>{copy.provider} · {own.request.request.provider.name}</Text>
      <Text style={styles.detail}>{copy.status} · {copy.statuses[own.request.request.status]}</Text>
      <Text style={styles.detail}>{copy.simulatedNote}</Text>
      <Action label={copy.done} onPress={() => requests.cancel()} />
    </View>}
    {(own.request.kind === 'review' || own.request.kind === 'sending' || own.request.kind === 'failed') && <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>{copy.review}</Text>
      <Text style={styles.detail}>{copy.provider} · {own.request.provider.name}</Text>
      <Text style={styles.detail}>{own.request.provider.address}, {own.request.provider.city}</Text>
      <Text style={styles.detail}>{copy.where} · {own.request.place.kind === 'device' ? copy.device : `${copy.address}: ${own.request.place.address}`}</Text>
      {own.request.place.kind === 'device' && <Text style={styles.detail}>{copy.deviceNote}</Text>}
      {own.request.kind === 'sending' && <ActivityIndicator color={theme.colors.primary} accessibilityLabel={copy.sending} />}
      {own.request.kind === 'failed' && <Text accessibilityRole="alert" style={styles.error}>{copy.failures[own.request.failure]}</Text>}
      <Action label={copy.confirm} onPress={() => void requests.confirm()} disabled={own.request.kind === 'sending'} />
      <Action label={copy.back} onPress={() => requests.cancel()} disabled={own.request.kind === 'sending'} secondary />
    </View>}
    {!asking && <View style={styles.card}>
      <Text style={styles.detail}>{copy.purpose}</Text>
      <Action label={copy.location} onPress={searchByLocation} disabled={busy} />
      <Text style={styles.title}>{copy.manual}</Text>
      <TextInput accessibilityLabel={copy.manual} style={styles.input} placeholder={copy.placeholder}
        placeholderTextColor={theme.colors.muted} value={query} maxLength={160} returnKeyType="search"
        onChangeText={setQuery} onSubmitEditing={searchManually} />
      <Action label={copy.search} onPress={searchManually} disabled={query.trim().length < 2} />
    </View>}
    {!asking && busy && <ActivityIndicator color={theme.colors.primary} accessibilityLabel={copy.loading} />}
    {!asking && result.state !== 'idle' && result.state !== 'ready'
      && <Text style={styles.detail} accessibilityLiveRegion="polite">{copy[result.state]}</Text>}
    {!asking && result.state === 'ready' && result.providers.length === 0 && <Text style={styles.detail}>{copy.empty}</Text>}
    {!asking && result.state === 'ready' && result.providers.map(provider => <View key={provider.id} style={styles.card}>
      <Text style={styles.detail}>{copy.kinds[provider.kind]}{provider.distanceKm === undefined ? ''
        : ` · ${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(provider.distanceKm)} km`}</Text>
      <Text accessibilityRole="header" style={styles.title}>{provider.name}</Text>
      <Text style={styles.detail}>{provider.address}, {provider.city}</Text>
      <Text style={styles.detail}>{copy.contact} · {provider.phone}</Text>
      <Text style={styles.detail}>{copy.hours} · {provider.hours}</Text>
      <Action label={copy.request} onPress={() => requests.review(provider, result.place)} />
    </View>)}
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>{copy.mine}</Text>
      {own.own.status === 'loading' && <Text style={styles.detail}>{copy.mineLoading}</Text>}
      {own.own.status === 'failed' && <>
        <Text accessibilityRole="alert" style={styles.error}>{copy.mineFailed}</Text>
        <Action label={copy.retry} onPress={() => void requests.refresh()} secondary />
      </>}
      {own.own.status === 'ready' && own.own.requests.length === 0 && <Text style={styles.detail}>{copy.mineEmpty}</Text>}
      {own.own.status === 'ready' && own.own.requests.map(item => <View key={item.id} style={styles.row}>
        <Text style={styles.reference}>{item.reference}</Text>
        <Text style={styles.detail}>{item.provider.name} · {copy.statuses[item.status]}</Text>
        <Text style={styles.detail}>{new Date(item.createdAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })}</Text>
      </View>)}
    </View>
  </ScrollView>;
}

function Action({ label, onPress, disabled = false, secondary = false }: {
  label: string; onPress: () => void; disabled?: boolean; secondary?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} onPress={onPress} disabled={disabled}
    style={[styles.button, secondary && styles.secondary, disabled && styles.disabled]}>
    <Text style={[styles.buttonLabel, secondary && styles.secondaryLabel]}>{label}</Text>
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
  secondary: { backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border },
  secondaryLabel: { color: theme.colors.primaryDark },
  error: { color: theme.colors.warningText, fontSize: 14, lineHeight: 20, fontWeight: '600' },
  reference: { color: theme.colors.foreground, fontSize: 22, fontWeight: '700', letterSpacing: 0.4 },
  row: { gap: 2, paddingTop: 8, borderTopWidth: 1, borderColor: theme.colors.border },
  signedOut: { margin: 24, color: theme.colors.muted, fontSize: 15 },
});
