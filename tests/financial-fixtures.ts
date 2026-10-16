import { randomUUID } from 'node:crypto';
import { eventContent } from '../backend/policy-claims-payments/src/domain/financial';
import type { SignedOfferAcceptanceV1, SignedParametricEventV1 } from '../backend/policy-claims-payments/src/domain/financial';
import { HmacFinancialIntegrity } from '../backend/policy-claims-payments/src/adapters/outbound/financial-integrity';

export const financialKey = 'synthetic-financial-test-key-'.padEnd(48, 'x');
export const financialNow = () => new Date('2026-10-16T02:00:00.000Z');
export const financialIntegrity = new HmacFinancialIntegrity(financialKey);
export async function acceptedOffer(product: 'vida_hipotecario' | 'flight_delay' = 'vida_hipotecario'): Promise<SignedOfferAcceptanceV1> {
  const event: SignedOfferAcceptanceV1 = { version: 1, eventType: 'offer.accepted', eventId: randomUUID(), environment: 'local', synthetic: true,
    occurredAt: financialNow().toISOString(), correlationId: randomUUID(), signature: '', payload: {
      acceptanceId: randomUUID(), offerId: randomUUID(), offerVersion: 1, clientId: randomUUID(), subjectToken: randomUUID(), product,
      premium: product === 'flight_delay' ? '10000.0000' : '86400.0000', currency: 'COP',
      coverage: product === 'flight_delay' ? { kind: 'flight_delay', flightReference: randomUUID(), thresholdMinutes: 180, payoutAmount: '100000.0000' }
        : { kind: 'mortgage_life', sumInsured: '320000000.0000' },
      effectiveFrom: financialNow().toISOString(), effectiveUntil: product === 'flight_delay' ? '2026-10-17T02:00:00.000Z' : '2027-10-16T02:00:00.000Z',
      expiresAt: '2026-10-16T02:15:00.000Z', ruleVersion: product === 'flight_delay' ? 'academic-flight-1' : 'academic-mortgage-1', acceptedAt: financialNow().toISOString()
    } };
  event.signature = await financialIntegrity.digest(eventContent(event));
  return event;
}
export async function flightEvent(policyId: string, flightReference: string): Promise<SignedParametricEventV1> {
  const event: SignedParametricEventV1 = { version: 1, eventType: 'flight.delay_verified', eventId: randomUUID(), environment: 'local', synthetic: true,
    occurredAt: financialNow().toISOString(), correlationId: randomUUID(), signature: '', payload: { policyId, flightReference, delayMinutes: 180 } };
  event.signature = await financialIntegrity.digest(eventContent(event));
  return event;
}
