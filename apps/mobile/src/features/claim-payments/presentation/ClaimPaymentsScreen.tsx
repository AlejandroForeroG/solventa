import { useEffect, useState, useSyncExternalStore } from 'react';
import { useIsFocused } from 'expo-router';
import { ActivityIndicator, AppState, Text, View } from 'react-native';
import { useAuthenticatedSession, useAuthentication } from '../../authentication/presentation/AuthenticationProvider';
import { WelcomeScreen } from '../../welcome/presentation/WelcomeScreen';
import { useAppMessages } from '../../../shared/i18n/use-app-messages';
import { messages } from '../../../shared/i18n/messages';
import { Page, Action, ui } from '../../claim-report/presentation/ui';
import { ClaimPayments } from '../application/claim-payments';
import { createClaimPaymentsApi } from '../adapters/payments-api';
import { paymentMessages } from './messages';

export function ClaimPaymentsScreen() {
  const auth = useAuthentication(); const focused = useIsFocused();
  const session = useAuthenticatedSession();
  const locale = useAppMessages() === messages.en ? 'en-US' : 'es-CO';
  if (auth.status !== 'authenticated' || !auth.principal) return <WelcomeScreen />;
  if (!focused) return <Page title={paymentMessages[locale].title} />;
  return <Payments key={`${session.baseUrl}:${auth.principal.clientId}:${auth.principal.subjectToken}:${locale}`} locale={locale} owner={auth.principal} />;
}

function Payments({ locale, owner }: { locale: 'es-CO' | 'en-US'; owner: { clientId: string; subjectToken: string } }) {
  const session = useAuthenticatedSession();
  const [payments] = useState(() => new ClaimPayments(createClaimPaymentsApi(session.baseUrl, session, owner)));
  const state = useSyncExternalStore(payments.subscribe, payments.getSnapshot, payments.getSnapshot);
  const copy = paymentMessages[locale];
  useEffect(() => {
    void payments.refresh();
    const lifecycle = AppState.addEventListener('change', next => { if (next !== 'active') payments.lock(); else void payments.refresh(); });
    return () => { lifecycle.remove(); payments.lock(); };
  }, [payments]);
  return <Page title={copy.title} focusKey={state.status}>
    {state.status === 'loading' && <ActivityIndicator accessibilityLabel={copy.loading} />}
    {state.status === 'locked' && <Text style={ui.body}>{copy.locked}</Text>}
    {state.status === 'failed' && <Text accessibilityRole="alert" style={ui.notice}>{copy.failures[state.failure]}</Text>}
    {state.status === 'ready' && <>
      {state.page.items.length === 0 && <Text style={ui.body}>{copy.empty}</Text>}
      {state.page.items.map(item => {
        const [whole, fraction] = item.payment.amount.split('.');
        const amount = new Intl.NumberFormat(locale).format(BigInt(whole)) + (locale === 'es-CO' ? ',' : '.') + fraction + ' COP';
        return <View key={item.claimId} style={ui.card}>
          <Text accessibilityRole="header" style={ui.subtitle}>{item.claimNumber}</Text>
          <View style={item.payment.status === 'confirmed' ? ui.banner : ui.group}>
            <Text style={ui.label}>{copy[item.payment.status]}</Text><Text style={ui.caseNumber}>{amount}</Text>
          </View>
          <Text style={ui.caption}>{copy.simulated}</Text>
          {item.payment.status === 'pending' && <Text style={ui.notice}>{copy.pendingHelp}</Text>}
          {item.payment.reference && <Text selectable style={ui.body}>{copy.reference}: {item.payment.reference}</Text>}
          <Text style={ui.caption}>{copy.updated}: {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota' }).format(new Date(item.updatedAt))}</Text>
        </View>;
      })}
      {state.hasPrevious && <Action secondary label={copy.previous} onPress={() => void payments.back()} />}
      {state.page.next && <Action secondary label={copy.next} onPress={() => void payments.next()} />}
    </>}
    {state.status !== 'loading' && state.status !== 'locked' && <Action secondary label={copy.refresh} onPress={() => void payments.refresh()} />}
  </Page>;
}
