import type { FlightSchedule } from '../../application/ports/offer-store';

// Deliberately synthetic; this adapter makes no external provider call and consumes no PII.
export class MockFlightSchedule implements FlightSchedule {
  constructor(private readonly now = () => new Date()) {}
  async read(_flightReference: string) { return { available: true, capturedAt: this.now().toISOString(), providerMode: 'mock' as const }; }
}
