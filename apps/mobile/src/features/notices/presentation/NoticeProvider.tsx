import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type PropsWithChildren } from 'react';
import { AppState } from 'react-native';
import { pushPermission } from '../../notification-preferences/adapters/push-permission';
import { useAuthenticatedSession, useAuthentication } from '../../authentication/presentation/AuthenticationProvider';
import { useNoticeMessages } from './notice-messages';
import { createNoticePresenter, showNoticesInForeground } from '../adapters/expo-notice-presenter';
import { createNoticesApi } from '../adapters/notices-api';
import { NoticeCenter } from '../application/notice-center';
import { tappedNoticeId } from '../domain/destination';
import { clearNoticeLogin } from '../application/login-destination';

const Context = createContext<NoticeCenter | null>(null);
const POLL_MS = 60_000;

export function NoticeProvider({ children }: PropsWithChildren) {
  const auth = useAuthentication();
  const session = useAuthenticatedSession();
  const copy = useNoticeMessages();
  const [{ center, updateText }] = useState(() => {
    let text = { title: copy.notificationTitle, body: copy.notificationBody };
    return {
      center: new NoticeCenter({
        api: createNoticesApi(session.baseUrl, session),
        presenter: createNoticePresenter(() => text),
        permission: { granted: pushPermission },
      }),
      updateText: (title: string, body: string) => { text = { title, body }; },
    };
  });
  useEffect(() => { updateText(copy.notificationTitle, copy.notificationBody); }, [copy.notificationTitle, copy.notificationBody, updateText]);
  const authenticated = auth.status === 'authenticated';

  useEffect(() => { showNoticesInForeground(); }, []);
  useEffect(() => { if (auth.status === 'signedOut' || auth.status === 'logoutPending') clearNoticeLogin(); }, [auth.status]);
  useEffect(() => {
    // Consume the response before navigating so a restart cannot reopen a stale action.
    const open = (response: Notifications.NotificationResponse) => {
      Notifications.clearLastNotificationResponse();
      clearNoticeLogin();
      const eventId = tappedNoticeId(response.notification.request.content.data);
      if (eventId) router.navigate({ pathname: '/notice-action', params: { eventId } });
      else router.navigate('/alerts');
    };
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    void Notifications.getLastNotificationResponseAsync().then(response => { if (response) open(response); }).catch(() => undefined);
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!authenticated) { center.clear(); return; }
    void center.refresh();
    const lifecycle = AppState.addEventListener('change', state => { if (state === 'active') void center.refresh(); });
    const interval = setInterval(() => { if (AppState.currentState === 'active') void center.refresh(); }, POLL_MS);
    return () => { lifecycle.remove(); clearInterval(interval); };
  }, [authenticated, auth.principal, center]);
  return <Context.Provider value={center}>{children}</Context.Provider>;
}

export function useNotices() {
  const center = useContext(Context);
  if (!center) throw new Error('NoticeProvider is required');
  const snapshot = useSyncExternalStore(center.subscribe, center.getSnapshot, center.getSnapshot);
  return { center, snapshot };
}
