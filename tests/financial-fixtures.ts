import { randomUUID } from 'node:crypto';
import { eventContent } from '../backend/policy-claims-payments/src/domain/financial';
import type { SignedOfferAcceptanceV1, SignedParametricEventV1 } from '../backend/policy-claims-payments/src/domain/financial';
import { HmacFinancialIntegrity } from '../backend/policy-claims-payments/src/adapters/outbound/financial-integrity';
import { providerEventContent } from '../backend/policy-claims-payments/src/adapters/outbound/mock-parametric-provider';
import type { ProviderEventV1, ProviderReading } from '../backend/policy-claims-payments/src/adapters/outbound/mock-parametric-provider';

export const financialKey = 'synthetic-financial-test-key-'.padEnd(48, 'x');
export const financialNow = () => new Date('2026-10-16T02:00:00.000Z');
export const financialIntegrity = new HmacFinancialIntegrity(financialKey);
type Product = 'vida_hipotecario' | 'flight_delay' | 'weather_event';
const offerTerms = (product: Product): Pick<SignedOfferAcceptanceV1['payload'], 'premium' | 'coverage' | 'effectiveUntil' | 'ruleVersion'> => {
  if (product === 'flight_delay') return { premium: '10000.0000', coverage: { kind: 'flight_delay', flightReference: randomUUID(), thresholdMinutes: 180, payoutAmount: '100000.0000' },
    effectiveUntil: '2026-10-17T02:00:00.000Z', ruleVersion: 'academic-flight-1' };
  if (product === 'weather_event') return { premium: '15000.0000', coverage: { kind: 'weather_event', stationId: randomUUID(), parameter: 'precipitation_24h', unit: 'mm', threshold: 50, payoutAmount: '100000.0000' },
    effectiveUntil: '2026-10-17T02:00:00.000Z', ruleVersion: 'academic-weather-1' };
  return { premium: '86400.0000', coverage: { kind: 'mortgage_life', sumInsured: '320000000.0000' }, effectiveUntil: '2027-10-16T02:00:00.000Z', ruleVersion: 'academic-mortgage-1' };
};
export async function acceptedOffer(product: Product = 'vida_hipotecario'): Promise<SignedOfferAcceptanceV1> {
  const event: SignedOfferAcceptanceV1 = { version: 1, eventType: 'offer.accepted', eventId: randomUUID(), environment: 'local', synthetic: true,
    occurredAt: financialNow().toISOString(), correlationId: randomUUID(), signature: '', payload: {
      acceptanceId: randomUUID(), offerId: randomUUID(), offerVersion: 1, clientId: randomUUID(), subjectToken: randomUUID(), product,
      currency: 'COP', ...offerTerms(product), effectiveFrom: financialNow().toISOString(),
      expiresAt: '2026-10-16T02:15:00.000Z', acceptedAt: financialNow().toISOString()
    } };
  event.signature = await financialIntegrity.digest(eventContent(event));
  return event;
}
// A provider event signed as the simulated provider does; `unsigned` lets a case change a field before sealing it.
export async function providerEvent(policyId: string, reading: ProviderReading, unsigned: Partial<Omit<ProviderEventV1, 'signature'>> = {}): Promise<ProviderEventV1> {
  const body: Omit<ProviderEventV1, 'signature'> = { version: 1, providerEventId: randomUUID(), environment: 'local', synthetic: true,
    observedAt: '2026-10-16T02:30:00.000Z', policyId, reading, ...unsigned };
  return { ...body, signature: await financialIntegrity.digest(providerEventContent(body)) };
}
export async function flightEvent(policyId: string, flightReference: string): Promise<SignedParametricEventV1> {
  const event: SignedParametricEventV1 = { version: 1, eventType: 'flight.delay_verified', eventId: randomUUID(), environment: 'local', synthetic: true,
    occurredAt: financialNow().toISOString(), correlationId: randomUUID(), signature: '', payload: { policyId, flightReference, delayMinutes: 180 } };
  event.signature = await financialIntegrity.digest(eventContent(event));
  return event;
}
