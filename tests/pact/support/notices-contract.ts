import type { Notice } from '../../../backend/policy-claims-payments/src/domain/notice';

// The one notice both sides of the contract agree on: a confirmed parametric payment of the contract's policy.
export const contractNotice: Notice = {
  eventId: '70000000-0000-4000-8000-0000000000a1', kind: 'parametric_payment_confirmed', category: 'payments',
  policyId: '91000000-0000-4000-8000-000000000020', occurredAt: '2026-11-18T11:00:00.000Z',
};
