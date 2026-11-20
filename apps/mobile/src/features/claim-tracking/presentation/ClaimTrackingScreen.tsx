import { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Text, View } from 'react-native';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { isClaimCaseId, type CustomerClaimCase, type OwnedClaim } from '@solventa/contracts';
import { useAuthenticatedSession, useAuthentication } from '../../authentication/presentation/AuthenticationProvider';
import { WelcomeScreen } from '../../welcome/presentation/WelcomeScreen';
import { messages } from '../../../shared/i18n/messages';
import { useAppMessages } from '../../../shared/i18n/use-app-messages';
import { Page, Action, ui } from '../../claim-report/presentation/ui';
import { createClaimTrackingApi } from '../adapters/tracking-api';
import { trackingMessages } from './messages';

type Locale = keyof typeof trackingMessages;
type Owner = { clientId: string; subjectToken: string };
type ScreenData = { mode: 'loading' | 'inactive' } | { mode: 'error'; kind: 'forbidden' | 'unauthorized' | 'not_found' | 'unavailable' }
  | { mode: 'list'; items: OwnedClaim[] } | { mode: 'detail'; claim: CustomerClaimCase };

export function ClaimTrackingDetail() {
  const { claimId } = useLocalSearchParams<{ claimId?: string | string[] }>();
  return <ClaimTrackingScreen claimId={isClaimCaseId(claimId) ? claimId.toLowerCase() : null} />;
}

export function ClaimTrackingScreen({ claimId }: { claimId?: string | null }) {
  const auth = useAuthentication();
  const session = useAuthenticatedSession();
  const focused = useIsFocused();
  const locale = useAppMessages() === messages.en ? 'en-US' : 'es-CO';
  const copy = trackingMessages[locale];
  if (auth.status !== 'authenticated' || !auth.principal) return <WelcomeScreen />;
  if (!focused) return <Page title={copy.title} />;
  if (claimId === null) return <Page title={copy.unnamed}><Text accessibilityRole="alert" style={ui.notice}>{copy.not_found}</Text></Page>;
  return <Tracking key={`${session.baseUrl}:${auth.principal.clientId}:${auth.principal.subjectToken}:${claimId ?? ''}`}
    locale={locale} owner={auth.principal} claimId={claimId} />;
}

function Tracking({ locale, owner, claimId }: { locale: Locale; owner: Owner; claimId?: string }) {
  const session = useAuthenticatedSession();
  const [api] = useState(() => createClaimTrackingApi(session.baseUrl, session, owner));
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<ScreenData>({ mode: 'loading' });
  const copy = trackingMessages[locale];

  useEffect(() => {
    let read: AbortController | undefined;
    async function load() {
      read?.abort();
      const request = new AbortController();
      read = request;
      setSnapshot({ mode: 'loading' });
      if (claimId) {
        const result = await api.detail(claimId, request.signal);
        if (!request.signal.aborted) setSnapshot(result.kind === 'ok' ? { mode: 'detail', claim: result.value } : { mode: 'error', kind: result.kind });
      } else {
        const result = await api.list(request.signal);
        if (!request.signal.aborted) setSnapshot(result.kind === 'ok' ? { mode: 'list', items: result.value } : { mode: 'error', kind: result.kind });
      }
    }
    const onActivity = (active: boolean) => {
      if (active) void load();
      else { read?.abort(); setSnapshot({ mode: 'inactive' }); }
    };
    onActivity(AppState.currentState === 'active');
    const listener = AppState.addEventListener('change', state => onActivity(state === 'active'));
    return () => { read?.abort(); listener.remove(); };
  }, [api, claimId, revision]);

  const clock = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota' }).format(new Date(value));
  const title = snapshot.mode === 'detail' ? snapshot.claim.claimNumber : claimId ? copy.unnamed : copy.title;
  return <Page title={title} focusKey={snapshot.mode}>
    {snapshot.mode === 'loading' && <ActivityIndicator accessibilityLabel={copy.loading} />}
    {snapshot.mode === 'error' && <Text accessibilityRole="alert" style={ui.notice}>{copy[snapshot.kind]}</Text>}
    {snapshot.mode === 'list' && <>
      {!snapshot.items.length && <Text style={ui.body}>{copy.empty}</Text>}
      {snapshot.items.map(item => <Action key={item.claimId} secondary label={item.claimNumber + ' · ' + copy.states[item.state]}
        onPress={() => router.push({ pathname: '/claim-tracking/[claimId]', params: { claimId: item.claimId } })} />)}
    </>}
    {snapshot.mode === 'detail' && <>
      <View style={ui.banner}><Text accessibilityRole="header" style={ui.subtitle}>{copy.states[snapshot.claim.state]}</Text></View>
      {claimId && (snapshot.claim.state === 'approved' || snapshot.claim.state === 'paid') && <Action label={copy.receipt}
        onPress={() => router.push({ pathname: '/claim-payments', params: { claimId } })} />}
      {snapshot.claim.requirements.length > 0 && <View style={ui.card}>
        <Text accessibilityRole="header" style={ui.subtitle}>{copy.requirements}</Text>
        {snapshot.claim.requirements.map(item => <View key={item.id} style={ui.group}>
          <Text style={ui.label}>{copy[item.status]}</Text><Text style={ui.body}>{item.details}</Text>
          <Text style={ui.caption}>{copy.owner}</Text><Text style={ui.caption}>{copy.deadline} · {clock(item.deadline)}</Text>
        </View>)}
      </View>}
      <View style={ui.card}>
        <Text accessibilityRole="header" style={ui.subtitle}>{copy.history}</Text>
        {!snapshot.claim.history.length && <Text style={ui.body}>{copy.emptyHistory}</Text>}
        {snapshot.claim.history.map(event => <View key={event.id} style={ui.group}>
          <Text style={ui.label}>{copy.events[event.action]}</Text><Text style={ui.caption}>{clock(event.at)}</Text>
        </View>)}
      </View>
    </>}
    {snapshot.mode !== 'loading' && snapshot.mode !== 'inactive' && <Action label={copy.refresh} secondary onPress={() => {
      setSnapshot({ mode: 'loading' }); setRevision(value => value + 1);
    }} />}
  </Page>;
}
