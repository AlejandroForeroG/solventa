import { claimNoticeEventType, noticeConsumers, noticeDecisionCapture, type NoticeCategory, type NoticeKind, type NoticeState, type ReceiptOutcome } from '../domain/notice';
import type { NoticeRecord, NoticeStore } from './ports/notice';

// What the customer chose for push, by category, as Identity reports it for this very request.
export type PushChoices = Record<NoticeCategory | 'commercial', boolean>;
// The customer is the client of the notice and, for a claim, the subject it is addressed to.
export type NoticeOwner = { clientId: string; subjectToken?: string; destination?: string };
export type NoticeView = { eventId: string; kind: NoticeKind; category: NoticeCategory; policyId: string; occurredAt: string; state: NoticeState };
export type ReceiptResult = { status: 'recorded' | 'replayed'; state: NoticeState } | { status: 'not_found' } | { status: 'conflict' };

const WINDOW_MS = 30 * 24 * 3600 * 1000;
const UNCONFIRMED_AFTER_MS = 10 * 60 * 1000;
const eventTypeOf = { parametric_payment_confirmed: 'policy.indemnity.notice', policy_lifecycle_changed: 'policy.lifecycle.notice', policy_expiring: 'policy.expiry.notice', claim_status_changed: claimNoticeEventType } as const;

export class Notices {
  constructor(private readonly store: NoticeStore, private readonly clock: { now(): Date } = { now: () => new Date() }) {}

  // Applies the choices in force now, before anything is offered to the device. A choice that is off is recorded once and never offered again,
  // so turning it on later does not release old notices. A notice already offered but not yet presented is withdrawn while its choice is off.
  async list(owner: NoticeOwner, choices: PushChoices, traceId: string): Promise<NoticeView[]> {
    const now = this.clock.now();
    const consumers = noticeConsumers(owner.destination);
    const views: NoticeView[] = [];
    for (const first of await this.store.recent(owner.clientId, new Date(now.getTime() - WINDOW_MS), owner.subjectToken, owner.destination)) {
      let current: NoticeRecord = first;
      if (current.dispatch === null) {
        const outcome = choices[current.notice.category] ? 'offered' : 'suppressed_preference';
        const capture = owner.destination === undefined ? undefined : noticeDecisionCapture({ notice: current.notice, clientId: owner.clientId, destination: owner.destination,
          operation: 'dispatch', traceId, evaluatedAt: now.toISOString(), outcome, pushEnabled: choices[current.notice.category] });
        const written = await this.store.record(current.notice.eventId, eventTypeOf[current.notice.kind], consumers.dispatch, outcome, traceId, capture);
        // A concurrent request may have decided first: the stored decision is the one that counts.
        current = written === 'recorded' ? { ...current, dispatch: outcome, dispatchedAt: now.toISOString() }
          : await this.store.find(owner.clientId, current.notice.eventId, owner.subjectToken, owner.destination) ?? current;
      }
      if (current.dispatch !== 'offered') continue;
      if (current.receipt === null && !choices[current.notice.category]) continue;
      views.push({ ...current.notice, state: this.stateOf(current, now) });
    }
    return views;
  }

  // The device reports what happened to a notice it was offered. One outcome per notice: the same report again is a replay, a different one a conflict.
  async receipt(owner: NoticeOwner, eventId: string, outcome: ReceiptOutcome, traceId: string): Promise<ReceiptResult> {
    const found = await this.store.find(owner.clientId, eventId, owner.subjectToken, owner.destination);
    // A notice of another customer is the same as one that does not exist.
    if (!found) return { status: 'not_found' };
    if (found.dispatch !== 'offered') return { status: 'conflict' };
    if (found.receipt !== null) return found.receipt === outcome ? { status: 'replayed', state: found.receipt } : { status: 'conflict' };
    const capture = owner.destination === undefined ? undefined : noticeDecisionCapture({ notice: found.notice, clientId: owner.clientId, destination: owner.destination,
      operation: 'receipt', traceId, evaluatedAt: this.clock.now().toISOString(), outcome, reportedOutcome: outcome });
    const written = await this.store.record(eventId, eventTypeOf[found.notice.kind], noticeConsumers(owner.destination).receipt, outcome, traceId, capture);
    if (written === 'recorded') return { status: 'recorded', state: outcome };
    const stored = await this.store.find(owner.clientId, eventId, owner.subjectToken, owner.destination);
    return stored?.receipt === outcome ? { status: 'replayed', state: outcome } : { status: 'conflict' };
  }

  private stateOf(record: NoticeRecord, now: Date): NoticeState {
    if (record.receipt) return record.receipt;
    const since = record.dispatchedAt ? Date.parse(record.dispatchedAt) : now.getTime();
    return now.getTime() - since > UNCONFIRMED_AFTER_MS ? 'unconfirmed' : 'offered';
  }
}
