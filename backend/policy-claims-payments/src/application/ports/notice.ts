import type { DispatchOutcome, Notice, ReceiptOutcome } from '../../domain/notice';

export type NoticeRecord = { notice: Notice; dispatch: DispatchOutcome | null; dispatchedAt: string | null; receipt: ReceiptOutcome | null };

// Notices are read from the owner's stored events and their delivery is recorded in the inbox, keyed by event and consumer, so a repeat never repeats an effect.
export interface NoticeStore {
  // The owner's most recent notices, newest first and bounded.
  recent(clientId: string, since: Date): Promise<NoticeRecord[]>;
  find(clientId: string, eventId: string): Promise<NoticeRecord | null>;
  record(eventId: string, eventType: string, consumer: string, outcome: string, traceId: string): Promise<'recorded' | 'exists'>;
}
