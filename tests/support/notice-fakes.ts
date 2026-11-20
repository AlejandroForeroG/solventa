import type { NoticeRecord, NoticeStore } from '../../backend/policy-claims-payments/src/application/ports/notice';
import { noticeConsumers, type Notice, type NoticeDecisionCapture } from '../../backend/policy-claims-payments/src/domain/notice';

// A faithful copy of the store: the notices of an owner, and an inbox keyed by event and consumer.
export function memoryNoticeStore(seed: { owner: string; notice: Notice; claimId?: string }[], clock: { current: Date }) {
  const inbox = new Map<string, { outcome: string; at: Date }>();
  const key = (eventId: string, consumer: string) => `${eventId}|${consumer}`;
  const writes: string[] = [];
  const captures: NoticeDecisionCapture[] = [];
  const view = (notice: Notice, destination?: string): NoticeRecord => {
    const consumers = noticeConsumers(destination);
    return { notice, claimId: seed.find(row => row.notice.eventId === notice.eventId)?.claimId, dispatch: (inbox.get(key(notice.eventId, consumers.dispatch))?.outcome ?? null) as NoticeRecord['dispatch'],
      dispatchedAt: inbox.get(key(notice.eventId, consumers.dispatch))?.at.toISOString() ?? null, receipt: (inbox.get(key(notice.eventId, consumers.receipt))?.outcome ?? null) as NoticeRecord['receipt'] };
  };
  const store: NoticeStore = {
    recent: async (clientId, since, _subjectToken, destination) => seed.filter(row => row.owner === clientId && Date.parse(row.notice.occurredAt) > since.getTime()).map(row => view(row.notice, destination)),
    find: async (clientId, eventId, _subjectToken, destination) => { const row = seed.find(item => item.owner === clientId && item.notice.eventId === eventId); return row ? view(row.notice, destination) : null; },
    record: async (eventId, _type, consumer, outcome, _traceId, capture) => {
      if (inbox.has(key(eventId, consumer))) return 'exists';
      inbox.set(key(eventId, consumer), { outcome, at: clock.current }); writes.push(`${consumer}:${outcome}`);
      if (capture) captures.push(capture);
      return 'recorded';
    },
  };
  return { store, inbox, writes, captures };
}
