import type { FinancialIntegrity } from '../../application/ports/financial';
import type { ParametricEventProvider, ProviderEvent } from '../../application/ports/parametric';
import { HEX, iso, object, UUID } from '../../domain/financial';
import type { FinancialEnvironment } from '../../domain/financial';
import type { ParametricOccurrence } from '../../domain/parametric';

export type ProviderReading = { kind: 'flight_delay'; flightReference: string; delayMinutes: number }
  | { kind: 'weather_precipitation'; stationId: string; precipitationMm: number };
// parametric-provider-event.v1: the simulated provider's own format. It never enters the domain; this adapter translates it.
export type ProviderEventV1 = { version: 1; providerEventId: string; environment: FinancialEnvironment; synthetic: true;
  observedAt: string; policyId: string; reading: ProviderReading; signature: string };

const MAX_DELAY_MINUTES = 10080;
const MAX_PRECIPITATION_MM = 2000;
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const count = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const exactKeys = (value: Record<string, unknown>, names: string[]) => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));

function validReading(value: unknown): value is ProviderReading {
  if (!object(value)) return false;
  if (value.kind === 'flight_delay') return exactKeys(value, ['kind', 'flightReference', 'delayMinutes']) && uuid(value.flightReference) && count(value.delayMinutes, MAX_DELAY_MINUTES);
  return value.kind === 'weather_precipitation' && exactKeys(value, ['kind', 'stationId', 'precipitationMm']) && uuid(value.stationId) && count(value.precipitationMm, MAX_PRECIPITATION_MM);
}

export function isProviderEvent(value: unknown, environment: FinancialEnvironment): value is ProviderEventV1 {
  return object(value) && exactKeys(value, ['version', 'providerEventId', 'environment', 'synthetic', 'observedAt', 'policyId', 'reading', 'signature'])
    && value.version === 1 && value.environment === environment && value.synthetic === true && uuid(value.providerEventId) && uuid(value.policyId)
    && iso(value.observedAt) && validReading(value.reading) && typeof value.signature === 'string' && HEX.test(value.signature);
}

// The exact text the provider signs; the domain-separated prefix keeps it from validating as any other sealed content.
export function providerEventContent(event: Omit<ProviderEventV1, 'signature'>): string {
  const { reading } = event;
  const measured = reading.kind === 'flight_delay' ? [reading.kind, reading.flightReference, reading.delayMinutes]
    : [reading.kind, reading.stationId, reading.precipitationMm];
  return JSON.stringify(['parametric-provider-event-v1', event.version, event.providerEventId, event.environment, event.synthetic,
    event.observedAt, event.policyId, JSON.stringify(measured)]);
}

function occurrenceOf(event: ProviderEventV1): ParametricOccurrence {
  const { providerEventId: eventId, observedAt: occurredAt, policyId, reading } = event;
  return reading.kind === 'flight_delay'
    ? { eventId, occurredAt, eventType: 'flight.delay_verified', payload: { policyId, flightReference: reading.flightReference, delayMinutes: reading.delayMinutes } }
    : { eventId, occurredAt, eventType: 'weather.precipitation_verified', payload: { policyId, stationId: reading.stationId, precipitationMm: reading.precipitationMm } };
}

// Simulated external provider: it signs with the financial key and never contacts a real flight or weather service.
export class MockParametricEventProvider implements ParametricEventProvider {
  constructor(private readonly integrity: FinancialIntegrity, private readonly environment: FinancialEnvironment) {}
  async receive(input: unknown): Promise<ProviderEvent> {
    if (!isProviderEvent(input, this.environment)) return { status: 'invalid' };
    const { signature, ...unsigned } = input;
    const content = providerEventContent(unsigned);
    if (!(await this.integrity.verify(content, signature))) return { status: 'invalid' };
    return { status: 'verified', occurrence: occurrenceOf(input), content };
  }
}
