import { useIsFocused } from 'expo-router';

import { WalletScreen } from '@/features/policy-wallet/presentation/WalletScreen';

export default function WalletRoute() {
  return useIsFocused() ? <WalletScreen /> : null;
}
