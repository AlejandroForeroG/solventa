import type { DispatchOutcome, Notice, NoticeDecisionCapture, ReceiptOutcome } from '../../domain/notice';

// Stores, once per policy and expiry date, the notice that a policy is about to expire.
export interface ExpiryAnnouncer {
  announceExpiring(now: Date, windowMs: number): Promise<number>;
}

export type NoticeRecord = { notice: Notice; dispatch: DispatchOutcome | null; dispatchedAt: string | null; receipt: ReceiptOutcome | null };

// Notices are read from the owner's stored events and their delivery is recorded in the inbox, keyed by event and consumer, so a repeat never repeats an effect.
export interface NoticeStore {
  // The owner's most recent notices, newest first and bounded.
  // The subject token is what a claim notice is addressed to; without it only the notices that name the client are read.
  recent(clientId: string, since: Date, subjectToken?: string, destination?: string): Promise<NoticeRecord[]>;
  find(clientId: string, eventId: string, subjectToken?: string, destination?: string): Promise<NoticeRecord | null>;
  record(eventId: string, eventType: string, consumer: string, outcome: string, traceId: string, capture?: NoticeDecisionCapture): Promise<'recorded' | 'exists'>;
}
