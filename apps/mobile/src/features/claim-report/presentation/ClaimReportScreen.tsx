import { router } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { messages } from '@/shared/i18n/messages';
import { useAppMessages } from '@/shared/i18n/use-app-messages';
import { useAuthenticatedSession, useAuthentication } from '../../authentication/presentation/AuthenticationProvider';
import { createPoliciesApi } from '../../policy-wallet/adapters/policies-api';
import { policyReference, validityAt } from '../../policy-wallet/domain/wallet';
import { ActivePolicies } from '../application/active-policies';
import { isReportableProduct } from '../domain/report';
import { ClaimReportForm } from './ClaimReportForm';
import { createDraftApi } from '../../claim-drafts/adapters/draft-api';
import { draftMessages } from '../../claim-drafts/presentation/messages';
import { uuid, type DraftContent } from '../../claim-drafts/domain/draft';
import type { CachedPolicy } from '../../policy-cache/domain/cached-policy';
import type { AuthenticatedSession } from '../../policy-wallet/application/ports';
import { claimReportMessages, type ClaimReportCopy, type ClaimReportLocale } from './messages';
import { Action, Page, ui } from './ui';

// The camera and the gallery are system activities, so the app goes to the background and locks while the customer picks a file. These states end
// back in an authenticated session, so the report waits hidden through them; any other state means the session is really gone.
const REVALIDATING = new Set(['loading', 'authorizing', 'locked', 'biometricPrompt']);

export function ClaimReportScreen({ policyId, draftId }: { policyId?: string; draftId?: string }) {
  const auth = useAuthentication();
  const locale: ClaimReportLocale = useAppMessages() === messages.en ? 'en-US' : 'es-CO';
  const copy = claimReportMessages[locale];
  const current = auth.status === 'authenticated' && auth.principal ? auth.principal.clientId : undefined;
  const [owner, setOwner] = useState(current);
  // Derived from the session, never from an effect: a new account replaces the report, and a sign-out drops it.
  if (current !== undefined && current !== owner) setOwner(current);
  else if (current === undefined && owner !== undefined && !REVALIDATING.has(auth.status)) setOwner(undefined);

  if (owner === undefined) {
    return <Page title={copy.title}><Text style={ui.body}>{copy.policy.signedOut}</Text><Action label={copy.back} secondary onPress={() => router.back()} /></Page>;
  }
  return <Authenticated key={`${owner}:${locale}:${draftId ?? ''}`} copy={copy} locale={locale} requested={policyId} draftId={draftId} hidden={current === undefined} />;
}

function Authenticated({ copy, locale, requested, hidden, draftId }: { copy: ClaimReportCopy; locale: ClaimReportLocale; requested?: string; hidden: boolean; draftId?: string }) {
  const currentSession = useAuthenticatedSession();
  const [session] = useState(currentSession);
  const [policies] = useState(() => new ActivePolicies(() => createPoliciesApi(session.baseUrl, session).list(), (policy, now) => isReportableProduct(policy.product) && validityAt(policy, now) === 'active', Date.now));
  const load = useSyncExternalStore(policies.subscribe, policies.getSnapshot, policies.getSnapshot);
  const [chosen, choose] = useState<string | undefined>(requested);
  useEffect(() => { void policies.refresh(); }, [policies]);

  const content = (() => {
    if (load.status === 'loading') return <Page title={copy.title}><ActivityIndicator accessibilityLabel={copy.policy.loading} color="#0B6B5F" /></Page>;
    if (load.status === 'failed') return <Page title={copy.title}><Text accessibilityRole="alert" style={ui.notice}>{copy.policy.failed}</Text>
      <Action label={copy.retry} onPress={() => void policies.refresh()} /><Action label={copy.back} secondary onPress={() => router.back()} /></Page>;
    const options = load.policies;
    const policy = chosen ? options.find(item => item.policyId === chosen) : options.length === 1 ? options[0] : undefined;
    if (policy) return draftId ? <PreparedReport key={`${policy.policyId}:${draftId}`} policy={policy} draftId={draftId} copy={copy} locale={locale} session={session} />
      : <ClaimReportForm key={policy.policyId} policy={policy} copy={copy} locale={locale} session={session} />;
    return <Page title={copy.policy.heading} subtitle={copy.title}>
      {chosen && <Text accessibilityRole="alert" style={ui.notice}>{copy.policy.unknown}</Text>}
      {options.length === 0 && <Text style={ui.body}>{copy.policy.none}</Text>}
      {load.partial && <Text accessibilityRole="alert" style={ui.notice}>{copy.policy.partial}</Text>}
      <View style={ui.section}>
        {options.map(item => <Pressable key={item.policyId} accessibilityRole="button" onPress={() => choose(item.policyId)} style={({ pressed }) => [ui.card, pressed && ui.dimmed]}>
          <Text style={ui.subtitle}>{copy.products[item.product]}</Text>
          <Text style={ui.caption}>{policyReference(item.policyId)}</Text>
        </Pressable>)}
      </View>
      <Action label={copy.back} secondary onPress={() => router.back()} />
    </Page>;
  })();

  // The report stays mounted, with its state, while the session is revalidated, but nothing of it is shown until the session is back.
  return <>
    {hidden && <Page title={copy.title}><ActivityIndicator accessibilityLabel={copy.resuming} color="#0B6B5F" /><Text accessibilityLiveRegion="polite" style={ui.body}>{copy.resuming}</Text></Page>}
    <View style={hidden ? styles.hidden : styles.visible}>{content}</View>
  </>;
}

const styles = StyleSheet.create({ visible: { flex: 1 }, hidden: { display: 'none' } });

function PreparedReport({ policy, draftId, copy, locale, session }: { policy: CachedPolicy; draftId: string; copy: ClaimReportCopy;
  locale: ClaimReportLocale; session: AuthenticatedSession & { baseUrl: string } }) {
  const [state, setState] = useState<{ status: 'loading' | 'failed' } | { status: 'ready'; content: DraftContent }>({ status: 'loading' });
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!uuid(draftId)) throw new Error('invalid_draft');
      return createDraftApi(session.baseUrl, session).get(draftId);
    };
    void load().then(draft => {
      if (active) setState(draft.content.policyId === policy.policyId ? { status: 'ready', content: draft.content } : { status: 'failed' });
    }, () => { if (active) setState({ status: 'failed' }); });
    return () => { active = false; };
  }, [draftId, policy.policyId, session, attempt]);
  if (state.status !== 'ready') return <Page title={copy.title}>
    {state.status === 'loading' ? <ActivityIndicator accessibilityLabel={copy.policy.loading} /> : <>
      <Text accessibilityRole="alert" style={ui.notice}>{copy.policy.failed}</Text><Action label={copy.retry} onPress={() => { setState({ status: 'loading' }); retry(n => n + 1); }} />
    </>}
    <Action secondary label={copy.back} onPress={() => router.back()} />
  </Page>;
  return <ClaimReportForm policy={policy} copy={copy} locale={locale} session={session} initial={state.content} preparationNotice={draftMessages[locale].resumeNotice} />;
}
