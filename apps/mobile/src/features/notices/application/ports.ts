import type { Notice, ReceiptOutcome } from '../domain/notice';

export interface NoticesApi {
  list(): Promise<Notice[]>;
  receipt(eventId: string, outcome: ReceiptOutcome): Promise<void>;
}
// Shows one notice on the device. The text it uses never contains the amount, the policy or any personal data, because a lock screen may show it.
export interface NoticePresenter {
  present(notice: Notice): Promise<void>;
}
export interface PushPermission {
  granted(): Promise<boolean>;
}
