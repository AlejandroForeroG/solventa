import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ProviderFailure, type SignalProvider, type SignalSnapshot, type SignalSnapshots } from '../../backend/acquisition-risk/src/application/ports/signal-sources';
import type { OfferStore, StoredOffer, StoredOfferRequest } from '../../backend/acquisition-risk/src/application/ports/offer-store';
import type { OfferActor, OfferCapture } from '../../backend/acquisition-risk/src/domain/offer';
import type { MemoryStore } from './quote-fakes';

// In-memory stores shared by the journeys that drive the real gateway, Identity and Acquisition handlers.
export class FailingScope implements SignalProvider {
  constructor(private readonly inner: SignalProvider, private readonly failing: () => boolean) {}
  async read(subjectToken: string, scope: Parameters<SignalProvider['read']>[1], traceId: string) {
    if (this.failing() && scope === 'payment_history_score') throw new ProviderFailure('timeout');
    return this.inner.read(subjectToken, scope, traceId);
  }
}
export class NoSnapshots implements SignalSnapshots {
  async find(): Promise<SignalSnapshot | null> { return null; }
  async save() {}
}
export class JourneyOffers implements OfferStore {
  requests = new Map<string, StoredOfferRequest>(); offers = new Map<string, StoredOffer>(); captures = new Map<string, OfferCapture>();
  constructor(private readonly quotes: MemoryStore) {}
  async creationSnapshot(actor: OfferActor, key: string, quoteId: string | null) {
    const request = this.requests.get(actor.clientId + key) ?? null;
    const index = quoteId === null || request ? -1 : this.quotes.saved.findIndex((saved, position) => `COT-2026-${String(position + 1).padStart(5, '0')}` === quoteId
      && saved.actor.kind === 'user' && saved.actor.clientId === actor.clientId && saved.subjectToken === actor.subjectToken);
    const saved = this.quotes.saved[index];
    return { request, legacy: null, quote: saved ? { id: randomUUID(), quoteId: quoteId as string, amount: saved.amount, termMonths: saved.termMonths, ageYears: saved.capture.inputs.ageYears, validUntil: saved.validUntil } : null };
  }
  async create(input: Parameters<OfferStore['create']>[0]) {
    const existing = this.requests.get(input.actor.clientId + input.key);
    if (existing) return { created: false, request: existing };
    const request: StoredOfferRequest = { actor: input.actor, requestIdentity: input.requestIdentity, outcome: 'accepted', offer: input.offer };
    this.requests.set(input.actor.clientId + input.key, request); this.offers.set(input.offer.terms.offerId, input.offer); this.captures.set(input.offer.terms.offerId, input.capture as OfferCapture);
    return { created: true, request };
  }
  async decline(input: Parameters<OfferStore['decline']>[0]) {
    const request: StoredOfferRequest = { actor: input.actor, requestIdentity: input.requestIdentity, outcome: 'declined' };
    this.requests.set(input.actor.clientId + input.key, request);
    return { created: true, request };
  }
  async explanation(actor: OfferActor, offerId: string) {
    const offer = this.offers.get(offerId);
    return offer && offer.terms.clientId === actor.clientId ? this.captures.get(offerId) ?? null : null;
  }
  async get(): Promise<StoredOffer | null> { throw Error('not used'); }
  async acceptanceSnapshot(): Promise<never> { throw Error('not used'); }
  async accept(): Promise<never> { throw Error('not used'); }
  async reject() {}
}
