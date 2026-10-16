import type { SignalProvider } from '../../application/ports/signal-sources';
import type { Signal, SignalScope } from '../../domain/signal';
import type { FlightSchedule } from '../../application/ports/offer-store';

// Deliberately synthetic; this adapter makes no external provider call and consumes no PII.
export class MockRiskSignals implements SignalProvider {
  constructor(private readonly now = () => new Date()) {}
  async read(_subjectToken: string, scope: SignalScope, _traceId: string): Promise<Signal> {
    const data: Record<SignalScope, Signal['data']> = {
      income_obligations_12m: { monthlyIncomeCop: 8000000, monthlyObligationsCop: 1800000 },
      payment_history_score: { score: 780 }, affiliation_regime: { active: true }, identity_validation: { verified: true }
    };
    return { scope, capturedAt: this.now().toISOString(), data: data[scope] };
  }
}
export class MockFlightSchedule implements FlightSchedule {
  constructor(private readonly now = () => new Date()) {}
  async read(_flightReference: string) { return { available: true, capturedAt: this.now().toISOString(), providerMode: 'mock' as const }; }
}
