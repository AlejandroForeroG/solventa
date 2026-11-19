import type { ClaimPaymentPage } from '@solventa/contracts';

export class ClaimPaymentFailure extends Error {
  constructor(readonly code: 'unavailable' | 'invalid_response' | 'forbidden' | 'unauthorized') { super(code); }
}
export type PaymentScreenState = { status: 'locked' | 'loading' } | { status: 'failed'; failure: ClaimPaymentFailure['code'] }
  | { status: 'ready'; page: ClaimPaymentPage; hasPrevious: boolean };
