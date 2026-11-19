// What a customer is told about their policy, derived from the notices Policy already stores with its business effect.
export type NoticeCategory = 'policy' | 'payments';
export type NoticeKind = 'parametric_payment_confirmed' | 'policy_lifecycle_changed' | 'policy_expiring';
// offered: handed to the device and not yet confirmed; unconfirmed: offered long ago without a receipt, so presentation is uncertain.
export type NoticeState = 'offered' | 'unconfirmed' | 'presented' | 'permission_denied';
export type ReceiptOutcome = 'presented' | 'permission_denied';
export type DispatchOutcome = 'offered' | 'suppressed_preference';

export type Notice = { eventId: string; kind: NoticeKind; category: NoticeCategory; policyId: string; occurredAt: string };

export const noticeEventTypes = ['policy.indemnity.notice', 'policy.lifecycle.notice', 'policy.expiry.notice'] as const;
export const dispatchConsumer = 'notice.dispatch.v1';
export const receiptConsumer = 'notice.receipt.v1';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

// The preference category each kind answers to. A payment notice follows the payments choice; every policy change and every approaching expiry follow the policy choice.
const shape: Record<string, { kind: NoticeKind; category: NoticeCategory }> = {
  'policy.indemnity.notice': { kind: 'parametric_payment_confirmed', category: 'payments' },
  'policy.lifecycle.notice': { kind: 'policy_lifecycle_changed', category: 'policy' },
  'policy.expiry.notice': { kind: 'policy_expiring', category: 'policy' },
};

// A stored notice becomes a view only when it has exactly the identity of the kind it claims; anything else is ignored, never shown.
export function noticeFrom(row: { eventId: string; eventType: string; payload: unknown; createdAt: Date }): Notice | null {
  const known = shape[row.eventType];
  if (!known || !UUID.test(row.eventId) || !record(row.payload) || row.payload.category !== known.kind) return null;
  if (typeof row.payload.policyId !== 'string' || !UUID.test(row.payload.policyId)) return null;
  return { eventId: row.eventId.toLowerCase(), kind: known.kind, category: known.category, policyId: row.payload.policyId.toLowerCase(), occurredAt: row.createdAt.toISOString() };
}
