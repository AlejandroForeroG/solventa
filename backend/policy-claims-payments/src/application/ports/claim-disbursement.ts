import type { AcceptedOffer } from '../../domain/financial';
import type { ClaimState } from '../../domain/claims';
import type { Payment } from './financial';
import type { ClaimDecisionActor } from '../claim-decisions';
import type { DisbursementState } from '../../domain/claim-disbursement';
import type { ReportOwner } from './claim-report';

export type DisbursementContext = { claimId: string; decisionId: string; policyId: string; state: ClaimState; policyStatus: string;
  ownerSubjectToken: string; analystId: string; occurredAt: string; issuedAt: string; documentHash: string; signatureReceipt: string; timeSeal: string;
  premiumStatus: string; reservedAmount: string; offer: AcceptedOffer; termsHash: string; payment: Payment | null; indemnityId: string | null; indemnityAmount: string | null };
export type DisbursementCapture = { schemaVersion: 1; contractVersion: 'v1'; correlationId: string; inputs: Record<string, unknown>;
  sources: { source: string; capturedAt: string }[]; consent: { status: 'not_required' }; rule: { id: string; version: string }; outcome: string };
export interface DisbursementTransaction {
  owned(owner: ReportOwner, traceId: string, cursor?: string): Promise<(DisbursementContext & { claimNumber: string; updatedAt: string })[]>;
  // A caller with no assigned case receives no protected context, even on replay.
  authorized(claimId: string, actor: ClaimDecisionActor): Promise<DisbursementContext | null>;
  pending(paymentId: string): Promise<DisbursementContext | null>;
  create(context: DisbursementContext, payment: Payment, indemnityId: string, actor: ClaimDecisionActor, capture: DisbursementCapture): Promise<void>;
  finish(context: DisbursementContext, status: Exclude<DisbursementState, 'pending'>, reference: string | null, traceId: string, capture: DisbursementCapture): Promise<void>;
}
export interface DisbursementStore {
  transaction<T>(work: (tx: DisbursementTransaction) => Promise<T>, actor?: ClaimDecisionActor): Promise<T>;
  candidates(limit: number): Promise<string[]>;
}
export interface DisbursementDeadline { race<T>(work: Promise<T>, milliseconds: number, operation?: 'lookup' | 'settle'): Promise<T | 'expired'> }
