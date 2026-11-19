import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, Text } from 'react-native';
import { allowScreenCaptureAsync, enableAppSwitcherProtectionAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import { Page, ui } from '../../claim-report/presentation/ui';
import { paymentMessages } from './messages';

let nextLease = 0;
let sessionProtection: Promise<void> | undefined;

function protectReceiptSession() {
  sessionProtection ??= preventScreenCaptureAsync('claim-receipts-session').catch(error => {
    sessionProtection = undefined;
    throw error;
  });
  return sessionProtection;
}

export function ReceiptPrivacy({ locale, children }: { locale: 'es-CO' | 'en-US'; children: ReactNode }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const copy = paymentMessages[locale];
  useEffect(() => {
    const key = 'claim-receipts-' + ++nextLease;
    let mounted = true;
    const protection = preventScreenCaptureAsync(key).then(async () => {
      // Keep native protection through blur, backgrounding and late frame commits.
      await protectReceiptSession();
      if (Platform.OS === 'ios') await enableAppSwitcherProtectionAsync(1);
    });
    void protection.then(() => { if (mounted) setStatus('ready'); }, () => { if (mounted) setStatus('failed'); });
    return () => {
      mounted = false;
      // Release this mount only; the session guard remains until process restart.
      void protection.catch(() => undefined).then(async () => {
        await allowScreenCaptureAsync(key);
      }).catch(() => { console.warn('claim_receipt_privacy_release_failed'); });
    };
  }, []);
  if (status === 'ready') return children;
  return <Page title={copy.title}>
    {status === 'loading' ? <ActivityIndicator accessibilityLabel={copy.loading} />
      : <Text accessibilityRole="alert" style={ui.notice}>{copy.privacyUnavailable}</Text>}
  </Page>;
}
