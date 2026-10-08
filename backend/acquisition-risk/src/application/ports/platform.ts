import type { QuoteRequest } from '../../domain/quote';

export interface Clock { now(): Date }

export interface Protector {
  fingerprint(partnerId: string, request: QuoteRequest): Promise<string>;
  documentToken(documentNumber: string): Promise<string>;
}
