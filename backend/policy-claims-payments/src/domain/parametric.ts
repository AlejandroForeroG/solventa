import type { Coverage, FinancialResult, ParametricPayload } from './financial';

export type WeatherPayload = { policyId: string; stationId: string; precipitationMm: number };

// A verified occurrence, whichever provider format or transport delivered it.
export type ParametricOccurrence = { eventId: string; occurredAt: string } & (
  { eventType: 'flight.delay_verified'; payload: ParametricPayload } | { eventType: 'weather.precipitation_verified'; payload: WeatherPayload });

// What the provider boundary may learn: no policy document, hash or customer data.
export type ParametricResult = { status: 'ok'; replayed: boolean; policyId: string; indemnity: { status: 'confirmed'; reference: string } }
  | Extract<FinancialResult, { status: 'denied' | 'unavailable' }>;

// The occurrence must name the insured flight or station and reach the threshold fixed by the policy's own coverage.
export function occurrenceCovered(coverage: Coverage, occurrence: ParametricOccurrence): boolean {
  if (occurrence.eventType === 'flight.delay_verified') {
    return coverage.kind === 'flight_delay' && coverage.flightReference === occurrence.payload.flightReference
      && occurrence.payload.delayMinutes >= coverage.thresholdMinutes;
  }
  return coverage.kind === 'weather_event' && coverage.stationId === occurrence.payload.stationId
    && occurrence.payload.precipitationMm >= coverage.threshold;
}

// Only a parametric coverage owes an indemnity; a mortgage policy never does.
export function indemnityAmount(coverage: Coverage): string | null {
  return coverage.kind === 'mortgage_life' ? null : coverage.payoutAmount;
}

export function occurrenceEvidence(occurrence: ParametricOccurrence, environment: string) {
  const { eventId, eventType, occurredAt } = occurrence;
  const observed = occurrence.eventType === 'flight.delay_verified' ? { delayMinutes: occurrence.payload.delayMinutes }
    : { precipitationMm: occurrence.payload.precipitationMm };
  return { eventId, eventType, environment, occurredAt, ...observed };
}
