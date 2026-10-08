import type { DecisionCapture } from '../../domain/quote';
import type { QuoteActor } from './api-access';

export type NewQuote = {
  actor: QuoteActor;
  // Partner: keyed hash of the customer's document. Web user: the user's own pseudonymous subject token.
  subjectToken: string;
  idempotencyKey: string;
  requestFingerprint: string;
  capture: DecisionCapture;
  amount: number;
  termMonths: number;
  premiumMonthly: number;
  ruleVersion: string;
  validUntil: string;
  year: number;
  traceId: string;
};

export type StoredQuote = { quoteId: string; premiumMonthly: number; sumInsured: number; termMonths: number; validUntil: string; ruleVersion: string };

export type SaveResult =
  | { kind: 'created'; quote: StoredQuote }
  | { kind: 'replayed'; quote: StoredQuote }
  | { kind: 'conflict' };

// Idempotency is decided inside save, in one statement, so concurrent retries create one quote.
export interface QuoteStore {
  save(quote: NewQuote): Promise<SaveResult>;
}
