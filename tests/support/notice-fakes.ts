import type { NoticeRecord, NoticeStore } from '../../backend/policy-claims-payments/src/application/ports/notice';
import { dispatchConsumer, receiptConsumer, type Notice } from '../../backend/policy-claims-payments/src/domain/notice';

// A faithful copy of the store: the notices of an owner, and an inbox keyed by event and consumer.
export function memoryNoticeStore(seed: { owner: string; notice: Notice }[], clock: { current: Date }) {
  const inbox = new Map<string, { outcome: string; at: Date }>();
  const key = (eventId: string, consumer: string) => `${eventId}|${consumer}`;
  const writes: string[] = [];
  const view = (notice: Notice): NoticeRecord => ({ notice, dispatch: (inbox.get(key(notice.eventId, dispatchConsumer))?.outcome ?? null) as NoticeRecord['dispatch'],
    dispatchedAt: inbox.get(key(notice.eventId, dispatchConsumer))?.at.toISOString() ?? null, receipt: (inbox.get(key(notice.eventId, receiptConsumer))?.outcome ?? null) as NoticeRecord['receipt'] });
  const store: NoticeStore = {
    recent: async (clientId, since) => seed.filter(row => row.owner === clientId && Date.parse(row.notice.occurredAt) > since.getTime()).map(row => view(row.notice)),
    find: async (clientId, eventId) => { const row = seed.find(item => item.owner === clientId && item.notice.eventId === eventId); return row ? view(row.notice) : null; },
    record: async (eventId, _type, consumer, outcome) => {
      if (inbox.has(key(eventId, consumer))) return 'exists';
      inbox.set(key(eventId, consumer), { outcome, at: clock.current }); writes.push(`${consumer}:${outcome}`); return 'recorded';
    },
  };
  return { store, inbox, writes };
}
