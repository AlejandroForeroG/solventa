import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type PropsWithChildren } from 'react';
import { AppState } from 'react-native';
import { pushPermission } from '../../notification-preferences/adapters/push-permission';
import { useAuthenticatedSession, useAuthentication } from '../../authentication/presentation/AuthenticationProvider';
import { useNoticeMessages } from './notice-messages';
import { createNoticePresenter, showNoticesInForeground } from '../adapters/expo-notice-presenter';
import { createNoticesApi } from '../adapters/notices-api';
import { NoticeCenter } from '../application/notice-center';

const Context = createContext<NoticeCenter | null>(null);
const POLL_MS = 60_000;

export function NoticeProvider({ children }: PropsWithChildren) {
  const auth = useAuthentication();
  const session = useAuthenticatedSession();
  const copy = useNoticeMessages();
  const text = useRef({ title: copy.notificationTitle, body: copy.notificationBody });
  text.current = { title: copy.notificationTitle, body: copy.notificationBody };
  const [center] = useState(() => new NoticeCenter({
    api: createNoticesApi(session.baseUrl, session),
    presenter: createNoticePresenter(() => text.current),
    permission: { granted: pushPermission },
  }));
  const authenticated = auth.status === 'authenticated';

  useEffect(() => { showNoticesInForeground(); }, []);
  useEffect(() => {
    // Tapping a notice opens the alerts, which ask for the session again: a notice is not an authorization.
    // The last tapped response survives a restart until it is cleared, so it is cleared as soon as it is attended: otherwise every start would reopen the alerts.
    const open = () => { Notifications.clearLastNotificationResponse(); router.navigate('/alerts'); };
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    void Notifications.getLastNotificationResponseAsync().then(response => { if (response) open(); }).catch(() => undefined);
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
