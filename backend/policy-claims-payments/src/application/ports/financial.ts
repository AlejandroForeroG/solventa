import type { AcceptedOffer, FinancialEnvironment, FinancialErrorCode, PolicyStatus, PolicyView } from '../../domain/financial';

export type StoredPolicy = { id: string; clientId: string; subjectToken: string; status: PolicyStatus;
  offer: AcceptedOffer; termsHash: string; document: string; documentHash: string;
  premium: string; currency: string; offerId: string; offerVersion: number; effectiveFrom: string; effectiveUntil: string; coverageSnapshot: unknown };
export type Payment = { id: string; policyId: string; operation: 'premium' | 'indemnity'; amount: string; currency: 'COP';
  key: string; hash: string; status: 'pending' | 'confirmed' | 'refunded' | 'declined'; providerReference: string | null };
export type Command = { policyId: string; requestHash: string; result: PolicyView | null };
export type Inbox = { hash: string | null; policyId: string | null; outcome: string };
export interface FinancialTransaction {
  policy(id: string): Promise<StoredPolicy | null>;
  acceptedPolicy(acceptanceId: string): Promise<StoredPolicy | null>;
  offeredPolicy(offerId: string, offerVersion: number): Promise<StoredPolicy | null>;
  createPolicy(policy: StoredPolicy, eventId: string, traceId: string): Promise<void>;
  setPolicyStatus(id: string, status: PolicyStatus): Promise<void>;
  command(actorId: string, key: string): Promise<Command | null>;
  createCommand(actorId: string, key: string, policyId: string, requestHash: string): Promise<void>;
  finishCommand(actorId: string, key: string, result: PolicyView): Promise<void>;
  payment(policyId: string, operation: 'premium' | 'indemnity'): Promise<Payment | null>;
  createPayment(payment: Payment, traceId: string, claim?: { id: string; indemnityId: string; occurredAt: string }): Promise<void>;
  setPaymentStatus(id: string, status: Payment['status'], reference: string | null): Promise<void>;
  inbox(eventId: string, consumer: string): Promise<Inbox | null>;
  recordInbox(eventId: string, consumer: string, hash: string, policyId: string, eventType: string, traceId: string): Promise<void>;
  signature(policyId: string): Promise<{ documentHash: string; receipt: string; signedAt: string; timeSeal: string | null } | null>;
  recordSignature(policyId: string, documentHash: string, receipt: string, signedAt: string, timeSeal: string): Promise<void>;
  audit(action: 'offer.accepted' | 'premium.requested' | 'premium.declined' | 'premium.confirmed' | 'policy.issued' | 'premium.refund_requested' | 'premium.refunded' | 'parametric.accepted' | 'indemnity.confirmed' | 'financial.denied', resourceId: string, traceId: string, outcome: string, actorReference?: string): Promise<void>;
}
export interface FinancialStore {
  transaction<T>(work: (transaction: FinancialTransaction) => Promise<T>): Promise<T>;
  rejection(id: string, traceId: string, cause: FinancialErrorCode): Promise<void>;
}
export interface FinancialIntegrity {
  digest(content: string): Promise<string>;
  verify(content: string, signature: string): Promise<boolean>;
}
export interface PaymentGateway {
  settle(input: Payment): Promise<{ status: 'confirmed' | 'declined' | 'uncertain'; reference: string | null }>;
  lookup(input: Payment): Promise<{ status: 'confirmed' | 'refunded' | 'declined' | 'unknown'; reference: string | null }>;
  refund(input: Payment): Promise<{ status: 'refunded' | 'uncertain'; reference: string | null }>;
}
export interface SignatureProvider {
  sign(policyId: string, documentHash: string): Promise<{ status: 'signed'; receipt: string } | { status: 'failed' }>;
}
export type FinancialDependencies = { store: FinancialStore; integrity: FinancialIntegrity; payments: PaymentGateway;
  signatures: SignatureProvider; now(): Date; newId(): string; environment: FinancialEnvironment; enabled: boolean };
