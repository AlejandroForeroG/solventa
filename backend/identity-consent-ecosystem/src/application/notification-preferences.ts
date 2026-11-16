import { defaultNotificationMatrix, notificationMatrix, NotificationPreferenceFailure } from '../domain/notification-preferences';
import type { NotificationMatrix } from '../domain/notification-preferences';
import type { VerifiedIdentity } from './authentication';

export type NotificationPreferencesView = { version: number; preferences: NotificationMatrix };
export interface NotificationPreferenceStore {
  read(clientId: string, identity: VerifiedIdentity): Promise<NotificationPreferencesView | null>;
  save(input: { clientId: string; actor: string; preferences: NotificationMatrix; expectedVersion: number;
    key: string; requestHash: string; traceId: string; identity: VerifiedIdentity }): Promise<NotificationPreferencesView>;
}

export class NotificationPreferences {
  constructor(private readonly store: NotificationPreferenceStore) {}
  async read(clientId: string, identity: VerifiedIdentity): Promise<NotificationPreferencesView> {
    return await this.store.read(clientId, identity) ?? { version: 0, preferences: defaultNotificationMatrix };
  }
  async save(input: { clientId: string; actor: string; preferences: NotificationMatrix; expectedVersion: number;
    key: string; traceId: string; requestHash: string; identity: VerifiedIdentity }): Promise<NotificationPreferencesView> {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion > Number.MAX_SAFE_INTEGER - 1
      || !notificationMatrix(input.preferences) || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.key)
      || !/^[0-9a-f]{64}$/.test(input.requestHash))
      throw new NotificationPreferenceFailure('invalid_request', 400);
    return this.store.save(input);
  }
}
