import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { NoticePresenter } from '../application/ports';

const CHANNEL = 'solventa-notices';

// A foreground app still shows the notice, without sound or badge.
export function showNoticesInForeground() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
  });
}

// The lock screen may be seen by anyone, so privacy rests on the text: it is generic and never names the policy, the amount or the person.
// Android's channel option for lock-screen visibility was not applied by the emulator that was tested, so it is not relied on.
// The identifier is the notice's own, so presenting it again replaces the earlier one instead of stacking a duplicate.
export function createNoticePresenter(text: () => { title: string; body: string }): NoticePresenter {
  return {
    async present(notice) {
      if (Platform.OS === 'web') throw new Error('notices_unsupported');
      if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync(CHANNEL, { name: 'Solventa', importance: Notifications.AndroidImportance.DEFAULT });
      const { title, body } = text();
      await Notifications.scheduleNotificationAsync({
        identifier: notice.eventId,
        content: { title, body, data: { screen: 'alerts' } },
        trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null,
      });
    },
  };
}
