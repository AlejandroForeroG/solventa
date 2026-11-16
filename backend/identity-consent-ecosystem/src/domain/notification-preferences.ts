export const notificationCategories = ['policy', 'payments', 'claims', 'commercial'] as const;
export const notificationChannels = ['push', 'email', 'sms'] as const;
export type NotificationCategory = typeof notificationCategories[number];
export type NotificationChannel = typeof notificationChannels[number];
export type NotificationMatrix = Record<NotificationCategory, Record<NotificationChannel, boolean>>;

export const defaultNotificationMatrix: NotificationMatrix = {
  policy: { push: false, email: false, sms: false },
  payments: { push: false, email: false, sms: false },
  claims: { push: false, email: false, sms: false },
  commercial: { push: false, email: false, sms: false },
};

export function notificationMatrix(value: unknown): value is NotificationMatrix {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const categories = value as Record<string, unknown>;
  if (Object.keys(categories).length !== notificationCategories.length) return false;
  return notificationCategories.every(category => {
    const channels = categories[category];
    return !!channels && typeof channels === 'object' && !Array.isArray(channels)
      && Object.keys(channels).length === notificationChannels.length
      && notificationChannels.every(channel => typeof (channels as Record<string, unknown>)[channel] === 'boolean');
  });
}

export function canonicalNotificationRequest(expectedVersion: number, preferences: NotificationMatrix): string {
  return JSON.stringify({ expectedVersion, preferences: notificationCategories.map(category =>
    [category, ...notificationChannels.map(channel => preferences[category][channel])]) });
}

export class NotificationPreferenceFailure extends Error {
  constructor(readonly code: 'invalid_request' | 'conflict' | 'unauthorized', readonly status: 400 | 401 | 409) { super(code); }
}
