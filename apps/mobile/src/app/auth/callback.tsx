import { router } from 'expo-router';
import { useEffect } from 'react';

import { useAuthentication } from '@/features/authentication/presentation/AuthenticationProvider';
import { WelcomeScreen } from '@/features/welcome/presentation/WelcomeScreen';

export default function AuthCallbackRoute() {
  const { status } = useAuthentication();
  useEffect(() => {
    if (status !== 'loading' && status !== 'authorizing') router.dismissTo('/');
  }, [status]);
  return <WelcomeScreen />;
}
