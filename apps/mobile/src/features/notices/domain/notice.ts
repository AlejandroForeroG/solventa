export type NoticeKind = 'parametric_payment_confirmed' | 'policy_lifecycle_changed';
export type NoticeCategory = 'payments' | 'policy';
// offered: handed to this device and not confirmed; unconfirmed: offered long ago without a receipt, so its presentation is uncertain.
export type NoticeState = 'offered' | 'unconfirmed' | 'presented' | 'permission_denied';
export type ReceiptOutcome = 'presented' | 'permission_denied';
export type Notice = { eventId: string; kind: NoticeKind; category: NoticeCategory; policyId: string; occurredAt: string; state: NoticeState };

export class NoticeFailure extends Error {
  constructor(readonly code: 'unavailable' | 'invalid_response' | 'rejected') { super(code); this.name = 'NoticeFailure'; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

const kinds: readonly NoticeKind[] = ['parametric_payment_confirmed', 'policy_lifecycle_changed'];
const states: readonly NoticeState[] = ['offered', 'unconfirmed', 'presented', 'permission_denied'];
const categoryOf: Record<NoticeKind, NoticeCategory> = { parametric_payment_confirmed: 'payments', policy_lifecycle_changed: 'policy' };
const FIELDS = ['category', 'eventId', 'kind', 'occurredAt', 'policyId', 'state'];

// The server's list is untrusted: a notice is shown only when it has exactly the fields, kinds and states of the contract.
export function parseNotices(raw: unknown): Notice[] {
  if (!object(raw) || raw.simulated !== true || !Array.isArray(raw.notices) || raw.notices.length > 20) throw new NoticeFailure('invalid_response');
  return raw.notices.map(item => {
    if (!object(item) || Object.keys(item).sort().join() !== FIELDS.join()) throw new NoticeFailure('invalid_response');
    const { eventId, kind, category, policyId, occurredAt, state } = item;
    if (!uuid(eventId) || !uuid(policyId) || !kinds.includes(kind as NoticeKind) || !states.includes(state as NoticeState)
      || typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt)) || category !== categoryOf[kind as NoticeKind]) throw new NoticeFailure('invalid_response');
    return { eventId: eventId.toLowerCase(), kind: kind as NoticeKind, category: category as NoticeCategory, policyId: policyId.toLowerCase(), occurredAt, state: state as NoticeState };
  });
}

export function parseReceipt(raw: unknown, eventId: string, outcome: ReceiptOutcome): void {
  if (!object(raw) || typeof raw.replayed !== 'boolean' || raw.state !== outcome || typeof raw.eventId !== 'string' || raw.eventId.toLowerCase() !== eventId.toLowerCase()) throw new NoticeFailure('invalid_response');
}
