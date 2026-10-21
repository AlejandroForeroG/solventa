import type { OfferActor, OfferCapture, OfferQuote, OfferTerms } from '../../domain/offer';

export type StoredOffer = { terms: OfferTerms; seal: string; consentId: string; consentVersion: number };
export type StoredOfferRequest = { actor: OfferActor; requestIdentity: string } & ({ outcome: 'declined' } | { outcome: 'accepted'; offer: StoredOffer });
export type OfferRequestResult = { created: boolean; request: StoredOfferRequest };
export type AcceptedOffer = { acceptanceId: string; offerId: string; eventId: string; acceptedAt: string; status: 'pending_issuance'; synthetic: true };
export type AcceptanceEvent = { version: 1; eventType: 'offer.accepted'; eventId: string; environment: string; synthetic: true; occurredAt: string; correlationId: string; payload: Omit<OfferTerms, 'quoteId' | 'synthetic' | 'status'> & { acceptanceId: string; acceptedAt: string }; signature: string };
export type OfferCreationSnapshot = { request: StoredOfferRequest | null; legacy: StoredOffer | null; quote: OfferQuote | null };
export type OfferAcceptanceSnapshot = { offer: StoredOffer | null; acceptance: AcceptedOffer | null };
export interface OfferStore {
  creationSnapshot(actor: OfferActor, key: string, quoteId: string | null): Promise<OfferCreationSnapshot>;
  acceptanceSnapshot(actor: OfferActor, offerId: string, key: string): Promise<OfferAcceptanceSnapshot>;
  get(actor: OfferActor, offerId: string): Promise<StoredOffer | null>;
  create(input: { actor: OfferActor; quote: OfferQuote | null; sourceReference: string; requestIdentity: string; key: string; offer: StoredOffer; capture: OfferCapture | Record<string, unknown>; traceId: string }): Promise<OfferRequestResult>;
  decline(input: { actor: OfferActor; quote: OfferQuote; key: string; requestIdentity: string; capture: OfferCapture; traceId: string }): Promise<OfferRequestResult>;
  accept(input: { actor: OfferActor; key: string; offer: StoredOffer; event: AcceptanceEvent; acceptance: AcceptedOffer; traceId: string; now: string; authorizedUntil: string }): Promise<{ status: 'created' | 'replayed'; acceptance: AcceptedOffer } | { status: 'conflict' | 'expired' }>;
  reject(actor: OfferActor, offerId: string, traceId: string, reason: 'expired' | 'integrity_invalid', operation?: 'offer.read' | 'offer.accept'): Promise<void>;
}
export interface OfferIntegrity {
  id(): string;
  seal(terms: OfferTerms, consent: { consentId: string; consentVersion: number }): Promise<string>;
  verify(terms: OfferTerms, seal: string, consent: { consentId: string; consentVersion: number }): Promise<boolean>;
  sign(event: Omit<AcceptanceEvent, 'signature'>): Promise<AcceptanceEvent>;
}
export interface FlightSchedule {
  read(flightReference: string): Promise<{ available: boolean; capturedAt: string; providerMode: 'mock' }>;
}
