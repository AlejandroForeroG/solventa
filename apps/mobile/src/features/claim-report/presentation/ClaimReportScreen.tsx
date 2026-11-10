import { router } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { messages } from '@/shared/i18n/messages';
import { useAppMessages } from '@/shared/i18n/use-app-messages';
import { useAuthenticatedSession, useAuthentication } from '../../authentication/presentation/AuthenticationProvider';
import { createPoliciesApi } from '../../policy-wallet/adapters/policies-api';
import { policyReference, validityAt } from '../../policy-wallet/domain/wallet';
import { ActivePolicies } from '../application/active-policies';
import { isReportableProduct } from '../domain/report';
import { ClaimReportForm } from './ClaimReportForm';
import { claimReportMessages, type ClaimReportCopy, type ClaimReportLocale } from './messages';
import { Action, Page, ui } from './ui';

export function ClaimReportScreen({ policyId }: { policyId?: string }) {
  const auth = useAuthentication();
  const locale: ClaimReportLocale = useAppMessages() === messages.en ? 'en-US' : 'es-CO';
  const copy = claimReportMessages[locale];
  if (auth.status !== 'authenticated' || !auth.principal) {
    return <Page title={copy.title}><Text style={ui.body}>{copy.policy.signedOut}</Text><Action label={copy.back} secondary onPress={() => router.back()} /></Page>;
  }
  // Another account or language starts a new report, so a draft never crosses owners.
  return <Authenticated key={`${auth.principal.clientId}:${locale}`} copy={copy} locale={locale} requested={policyId} />;
}

function Authenticated({ copy, locale, requested }: { copy: ClaimReportCopy; locale: ClaimReportLocale; requested?: string }) {
  const current = useAuthenticatedSession();
  const [session] = useState(current);
  const [policies] = useState(() => new ActivePolicies(() => createPoliciesApi(session.baseUrl, session).list(), (policy, now) => isReportableProduct(policy.product) && validityAt(policy, now) === 'active', Date.now));
  const load = useSyncExternalStore(policies.subscribe, policies.getSnapshot, policies.getSnapshot);
  const [chosen, choose] = useState<string | undefined>(requested);
  useEffect(() => { void policies.refresh(); }, [policies]);

  if (load.status === 'loading') return <Page title={copy.title}><ActivityIndicator accessibilityLabel={copy.policy.loading} color="#0B6B5F" /></Page>;
  if (load.status === 'failed') return <Page title={copy.title}><Text accessibilityRole="alert" style={ui.notice}>{copy.policy.failed}</Text>
    <Action label={copy.retry} onPress={() => void policies.refresh()} /><Action label={copy.back} secondary onPress={() => router.back()} /></Page>;

  const options = load.policies;
  const policy = chosen ? options.find(item => item.policyId === chosen) : options.length === 1 ? options[0] : undefined;
  if (policy) return <ClaimReportForm key={policy.policyId} policy={policy} copy={copy} locale={locale} session={session} />;

  return <Page title={copy.policy.heading} subtitle={copy.title}>
    {chosen && <Text accessibilityRole="alert" style={ui.notice}>{copy.policy.unknown}</Text>}
    {options.length === 0 && <Text style={ui.body}>{copy.policy.none}</Text>}
    <View style={ui.section}>
      {options.map(item => <Pressable key={item.policyId} accessibilityRole="button" onPress={() => choose(item.policyId)} style={({ pressed }) => [ui.card, pressed && ui.dimmed]}>
        <Text style={ui.subtitle}>{copy.products[item.product]}</Text>
        <Text style={ui.caption}>{policyReference(item.policyId)}</Text>
      </Pressable>)}
    </View>
    <Action label={copy.back} secondary onPress={() => router.back()} />
  </Page>;
}
