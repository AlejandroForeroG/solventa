import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, Text } from 'react-native';
import { allowScreenCaptureAsync, disableAppSwitcherProtectionAsync, enableAppSwitcherProtectionAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import { Page, ui } from '../../claim-report/presentation/ui';
import { paymentMessages } from './messages';

const owners = new Set<string>();
let nextLease = 0;

export function ReceiptPrivacy({ locale, children }: { locale: 'es-CO' | 'en-US'; children: ReactNode }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const copy = paymentMessages[locale];
  useEffect(() => {
    const key = 'claim-receipts-' + ++nextLease;
    let mounted = true;
    owners.add(key);
    const protection = preventScreenCaptureAsync(key).then(async () => {
      if (Platform.OS === 'ios') await enableAppSwitcherProtectionAsync();
    });
    void protection.then(() => { if (mounted) setStatus('ready'); }, () => { if (mounted) setStatus('failed'); });
    return () => {
      mounted = false;
      // Finish a late acquisition before releasing only this mount's protection.
      void protection.catch(() => undefined).then(async () => {
        owners.delete(key);
        if (Platform.OS === 'ios' && owners.size === 0) await disableAppSwitcherProtectionAsync();
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
