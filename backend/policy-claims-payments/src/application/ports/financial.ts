import type { AcceptedOffer, FinancialActor, FinancialEnvironment, FinancialErrorCode, PolicyStatus, PolicyView } from '../../domain/financial';
import type { FinancialAction, FinancialDecisionCapture } from '../financial-decision';

export type StoredPolicy = { id: string; clientId: string; subjectToken: string; status: PolicyStatus;
  offer: AcceptedOffer; termsHash: string; document: string; documentHash: string;
  premium: string; currency: string; offerId: string; offerVersion: number; effectiveFrom: string; effectiveUntil: string; coverageSnapshot: unknown };
export type Payment = { id: string; policyId: string; operation: 'premium' | 'indemnity'; amount: string; currency: 'COP';
  key: string; hash: string; status: 'pending' | 'confirmed' | 'refunded' | 'declined'; providerReference: string | null };
export type Command = { policyId: string; requestHash: string; result: PolicyView | null };
export type Inbox = { hash: string | null; policyId: string | null; outcome: string };
export type Signature = { documentHash: string; receipt: string; signedAt: string; timeSeal: string | null };
// Policy, premium and signature evidence from one database snapshot; writes must reread under their transaction lock.
export type PolicyRecord = { policy: StoredPolicy; premium: Payment | null; signature: Signature | null };
// A foreign acceptance carries no record: its evidence is never selected or decoded.
export type AcceptedPolicyLookup = { status: 'absent' } | { status: 'foreign' } | { status: 'owned'; record: PolicyRecord };
export type IssuanceCommit = { policy: StoredPolicy; signature: Signature & { timeSeal: string }; commandKey: string;
  result: PolicyView; capture: FinancialDecisionCapture; traceId: string };
export type AcceptanceSnapshot = { inbox: Inbox | null; conflict: boolean };
export type ImportedEvent = { eventId: string; consumer: string; eventType: string; hash: string };
export type AcceptanceImport = { status: 'created' } | { status: 'existing'; snapshot: AcceptanceSnapshot };
export type PremiumStart = { policy: StoredPolicy; payment: Payment; command: { key: string; requestHash: string } | null;
  traceId: string; capture: FinancialDecisionCapture };
export interface FinancialTransaction {
  policy(id: string, actor?: FinancialActor): Promise<PolicyRecord | null>;
  issuanceSnapshot(id: string, actor: FinancialActor, commandKey: string): Promise<{ record: PolicyRecord | null; command: Command | null }>;
  beginPremium(input: PremiumStart): Promise<void>;
  setPolicyStatus(id: string, status: PolicyStatus): Promise<void>;
  createCommand(actorId: string, key: string, policyId: string, requestHash: string): Promise<void>;
  finishCommand(actorId: string, key: string, result: PolicyView): Promise<void>;
  payment(policyId: string, operation: 'premium' | 'indemnity'): Promise<Payment | null>;
  createPayment(payment: Payment, traceId: string, claim?: { id: string; indemnityId: string; occurredAt: string }): Promise<void>;
  setPaymentStatus(id: string, status: Payment['status'], reference: string | null): Promise<void>;
  inbox(eventId: string, consumer: string): Promise<Inbox | null>;
  recordInbox(eventId: string, consumer: string, hash: string, policyId: string, eventType: string, traceId: string): Promise<void>;
  confirmPremium(policy: StoredPolicy, payment: Payment, traceId: string, capture: FinancialDecisionCapture): Promise<void>;
  completeIssuance(input: IssuanceCommit): Promise<Signature>;
  audit(action: FinancialAction, resourceId: string, traceId: string, outcome: string, actorReference: string, capture: FinancialDecisionCapture): Promise<void>;
}
export interface FinancialStore {
  readPolicy(id: string, actor: FinancialActor): Promise<PolicyRecord | null>;
  readAcceptedPolicy(acceptanceId: string, actor: FinancialActor): Promise<AcceptedPolicyLookup>;
  importAcceptance(policy: StoredPolicy, event: ImportedEvent, traceId: string, capture: FinancialDecisionCapture): Promise<AcceptanceImport>;
  transaction<T>(work: (transaction: FinancialTransaction) => Promise<T>): Promise<T>;
  rejection(id: string, traceId: string, cause: FinancialErrorCode, capture: FinancialDecisionCapture): Promise<void>;
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
