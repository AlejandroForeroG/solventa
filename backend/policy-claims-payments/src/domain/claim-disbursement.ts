import { money, object, UUID, type AcceptedOffer } from './financial';

export type DisbursementInput = { amount: string };
export type DisbursementState = 'pending' | 'confirmed' | 'declined';
export type DisbursementView = { paymentId: string; amount: string; currency: 'COP'; status: DisbursementState; reference: string | null; simulated: true };

export function parseDisbursement(value: unknown): DisbursementInput | null {
  return object(value) && Object.keys(value).join(',') === 'amount' && money(value.amount) ? { amount: value.amount } : null;
}

export function disbursementLimit(offer: AcceptedOffer): string {
  return offer.coverage.kind === 'mortgage_life' ? offer.coverage.sumInsured : offer.coverage.payoutAmount;
}

export function amountWithinCoverage(amount: string, limit: string, reserved = '0.0000'): boolean {
  return money(amount) && money(limit) && money(reserved, false)
    && BigInt(amount.replace('.', '')) + BigInt(reserved.replace('.', '')) <= BigInt(limit.replace('.', ''));
}

// The approval, rather than a browser command ID, owns this single complete disbursement.
export function disbursementKey(decisionId: string): string {
  if (!UUID.test(decisionId)) throw Error('invalid_claim_decision');
  return 'approved-claim:' + decisionId;
}
