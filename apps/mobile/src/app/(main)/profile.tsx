import { Redirect } from 'expo-router';

import { useAuthentication } from '@/features/authentication/presentation/AuthenticationProvider';
import { WelcomeScreen } from '@/features/welcome/presentation/WelcomeScreen';

export default function ProfileRoute() {
  const { status } = useAuthentication();
  return status === 'signedOut' ? <Redirect href="/" /> : <WelcomeScreen profile />;
}
