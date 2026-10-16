import type { AcceptanceEvent, OfferIntegrity } from '../../application/ports/offer-store';
import type { OfferTerms } from '../../domain/offer';

function coverageContent(t: OfferTerms['coverage']) {
  return t.kind === 'mortgage_life' ? ['mortgage_life', t.sumInsured] : ['flight_delay', t.flightReference, t.thresholdMinutes, t.payoutAmount];
}
function termsContent(t: OfferTerms, consent: { consentId: string; consentVersion: number }) {
  return JSON.stringify(['offer-terms-v1', t.offerId, t.offerVersion, t.quoteId, t.clientId, t.subjectToken, t.product, t.premium, t.currency,
    coverageContent(t.coverage), t.effectiveFrom, t.effectiveUntil, t.expiresAt, t.ruleVersion, t.synthetic, t.status, consent.consentId, consent.consentVersion]);
}
// Boundary canonicalization matches financial-event-v1; business entities are not imported from Policy.
export function acceptanceContent(event: Omit<AcceptanceEvent, 'signature'>): string {
  const p = event.payload;
  const payload = JSON.stringify([p.acceptanceId, p.offerId, p.offerVersion, p.clientId, p.subjectToken, p.product, p.premium, p.currency,
    coverageContent(p.coverage), p.effectiveFrom, p.effectiveUntil, p.expiresAt, p.ruleVersion, p.acceptedAt]);
  return JSON.stringify(['financial-event-v1', event.version, event.eventType, event.eventId, event.environment, event.synthetic, event.occurredAt, event.correlationId, payload]);
}
export class HmacOfferIntegrity implements OfferIntegrity {
  private key?: Promise<CryptoKey>;
  constructor(private readonly secret: string) {}
  id() { return crypto.randomUUID(); }
  private getKey() {
    if (this.secret.length < 32) throw new Error('financial_event_key_invalid');
    this.key ??= crypto.subtle.importKey('raw', new TextEncoder().encode(this.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    return this.key;
  }
  private async mac(content: string) {
    const signed = await crypto.subtle.sign('HMAC', await this.getKey(), new TextEncoder().encode(content));
    return [...new Uint8Array(signed)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  seal(terms: OfferTerms, consent: { consentId: string; consentVersion: number }) { return this.mac(termsContent(terms, consent)); }
  async verify(terms: OfferTerms, seal: string, consent: { consentId: string; consentVersion: number }) {
    if (!/^[a-f0-9]{64}$/.test(seal)) return false;
    const bytes = Uint8Array.from(seal.match(/../g)!, b => Number.parseInt(b, 16));
    return crypto.subtle.verify('HMAC', await this.getKey(), bytes, new TextEncoder().encode(termsContent(terms, consent)));
  }
  async sign(event: Omit<AcceptanceEvent, 'signature'>): Promise<AcceptanceEvent> { return { ...event, signature: await this.mac(acceptanceContent(event)) }; }
  async verifyEvent(event: AcceptanceEvent): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(event.signature)) return false;
    const bytes = Uint8Array.from(event.signature.match(/../g)!, b => Number.parseInt(b, 16));
    return crypto.subtle.verify('HMAC', await this.getKey(), bytes, new TextEncoder().encode(acceptanceContent(event)));
  }
}
