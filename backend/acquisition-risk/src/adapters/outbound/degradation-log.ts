import { DEGRADATION_VERSION } from '../../domain/signal';
import type { DegradationTrace, SignalDegradation } from '../../application/ports/signal-sources';
import type { Timer } from '../../application/ports/platform';

// One line per replaced source. Only normalized values: the subject token and the provider's data stay out of the logs.
export class ConsoleDegradationTrace implements DegradationTrace {
  record(traceId: string, degradation: SignalDegradation): void {
    console.warn(JSON.stringify({ event: 'signal_degraded', traceId, rule: DEGRADATION_VERSION, ...degradation }));
  }
}

export const platformTimer: Timer = { after: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) };
