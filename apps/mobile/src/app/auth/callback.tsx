import { router } from 'expo-router';
import { useEffect } from 'react';

import { useAuthentication } from '@/features/authentication/presentation/AuthenticationProvider';
import { WelcomeScreen } from '@/features/welcome/presentation/WelcomeScreen';
import { clearNoticeLogin, consumeNoticeLogin } from '../../features/notices/application/login-destination';

export default function AuthCallbackRoute() {
  const { status } = useAuthentication();
  useEffect(() => {
    if (status !== 'loading' && status !== 'authorizing') {
      const eventId = status === 'authenticated' ? consumeNoticeLogin() : null;
      clearNoticeLogin();
      if (eventId) router.dismissTo({ pathname: '/notice-action', params: { eventId } });
      else router.dismissTo('/');
    }
  }, [status]);
  return <WelcomeScreen />;
}
