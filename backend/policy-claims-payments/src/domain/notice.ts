// What a customer is told about their policy, derived from the notices Policy already stores with its business effect.
export type NoticeCategory = 'policy' | 'payments' | 'claims';
export type NoticeKind = 'parametric_payment_confirmed' | 'policy_lifecycle_changed' | 'policy_expiring' | 'claim_status_changed';
// offered: handed to the device and not yet confirmed; unconfirmed: offered long ago without a receipt, so presentation is uncertain.
export type NoticeState = 'offered' | 'unconfirmed' | 'presented' | 'permission_denied';
export type ReceiptOutcome = 'presented' | 'permission_denied';
export type DispatchOutcome = 'offered' | 'suppressed_preference';

export type Notice = { eventId: string; kind: NoticeKind; category: NoticeCategory; policyId: string; occurredAt: string };

export type NoticeDecisionCapture = {
  schemaVersion: 1; contractVersion: 'v2'; correlationId: string;
  inputs: { clientId: string; eventId: string; destination: string; kind: NoticeKind; category: NoticeCategory; operation: 'dispatch' | 'receipt'; pushEnabled?: boolean; reportedOutcome?: ReceiptOutcome };
  sources: { source: string; capturedAt: string; quality: string }[];
  consent: { status: 'not_required' }; rule: { id: 'native-notice-delivery'; version: '2' }; outcome: string;
};

export function noticeDecisionCapture(input: {
  notice: Notice; clientId: string; destination: string; operation: 'dispatch' | 'receipt'; traceId: string; evaluatedAt: string;
  outcome: DispatchOutcome | ReceiptOutcome; pushEnabled?: boolean; reportedOutcome?: ReceiptOutcome;
}): NoticeDecisionCapture {
  return {
    schemaVersion: 1, contractVersion: 'v2', correlationId: input.traceId,
    inputs: { clientId: input.clientId, eventId: input.notice.eventId, destination: input.destination.toLowerCase(), kind: input.notice.kind, category: input.notice.category,
      operation: input.operation, ...(input.pushEnabled === undefined ? {} : { pushEnabled: input.pushEnabled }),
      ...(input.reportedOutcome === undefined ? {} : { reportedOutcome: input.reportedOutcome }) },
    sources: [
      { source: 'policy-stored-notice', capturedAt: input.notice.occurredAt, quality: 'stored' },
      { source: 'identity-session-installation', capturedAt: input.evaluatedAt, quality: 'verified' },
      ...(input.operation === 'receipt' ? [{ source: 'native-notice-receipt', capturedAt: input.evaluatedAt, quality: 'reported' }] : []),
    ],
    consent: { status: 'not_required' }, rule: { id: 'native-notice-delivery', version: '2' }, outcome: input.outcome,
  };
}

export const noticeEventTypes = ['policy.indemnity.notice', 'policy.lifecycle.notice', 'policy.expiry.notice'] as const;
// A claim notice for the customer is stored with the claim decision itself, addressed to the customer's subject; it has no outbox event of its own.
export const claimNoticeEventType = 'claim.customer.notice';
export const dispatchConsumer = 'notice.dispatch.v1';
export const receiptConsumer = 'notice.receipt.v1';

export function noticeConsumers(destination?: string) {
  return destination === undefined ? { dispatch: dispatchConsumer, receipt: receiptConsumer }
    : { dispatch: `notice.dispatch.v2:${destination.toLowerCase()}`, receipt: `notice.receipt.v2:${destination.toLowerCase()}` };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

// The preference category each kind answers to. A payment notice follows the payments choice; every policy change and every approaching expiry follow the policy choice.
const shape: Record<string, { kind: NoticeKind; category: NoticeCategory }> = {
  'policy.indemnity.notice': { kind: 'parametric_payment_confirmed', category: 'payments' },
  'policy.lifecycle.notice': { kind: 'policy_lifecycle_changed', category: 'policy' },
  'policy.expiry.notice': { kind: 'policy_expiring', category: 'policy' },
};

// A claim notice answers to the claims choice. It names the policy of the claim and nothing about the decision or the reason.
export function claimNoticeFrom(row: { eventId: string; policyId: string; createdAt: Date }): Notice | null {
  if (!UUID.test(row.eventId) || !UUID.test(row.policyId)) return null;
  return { eventId: row.eventId.toLowerCase(), kind: 'claim_status_changed', category: 'claims', policyId: row.policyId.toLowerCase(), occurredAt: row.createdAt.toISOString() };
}

// A stored notice becomes a view only when it has exactly the identity of the kind it claims; anything else is ignored, never shown.
export function noticeFrom(row: { eventId: string; eventType: string; payload: unknown; createdAt: Date }): Notice | null {
  const known = shape[row.eventType];
  if (!known || !UUID.test(row.eventId) || !record(row.payload) || row.payload.category !== known.kind) return null;
  if (typeof row.payload.policyId !== 'string' || !UUID.test(row.payload.policyId)) return null;
  return { eventId: row.eventId.toLowerCase(), kind: known.kind, category: known.category, policyId: row.payload.policyId.toLowerCase(), occurredAt: row.createdAt.toISOString() };
}
