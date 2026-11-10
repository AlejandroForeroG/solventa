import type { QuoteRequest } from '../../domain/quote';

export interface Clock { now(): Date }

// Resolves after the given milliseconds; the platform supplies the real one and tests a controllable one.
export interface Timer { after(milliseconds: number): Promise<void> }

export interface Protector {
  fingerprint(partnerId: string, request: QuoteRequest): Promise<string>;
  documentToken(documentNumber: string): Promise<string>;
  // An order key belongs to one partner and one authorization, so neither another partner nor another authorization replays its result.
  partnerKey(partnerId: string, authorizationId: string, idempotencyKey: string): Promise<string>;
}
