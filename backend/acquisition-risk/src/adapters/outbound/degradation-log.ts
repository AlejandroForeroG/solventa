import { DEGRADATION_VERSION } from '../../domain/signal';
import { SIGNAL_BUDGET_MS } from '../../application/ports/signal-sources';
import type { BudgetOverrun, DegradationTrace, SignalDegradation } from '../../application/ports/signal-sources';
import type { Timer } from '../../application/ports/platform';

// One line per replaced source. Only normalized values: the subject token and the provider's data stay out of the logs.
export class ConsoleDegradationTrace implements DegradationTrace {
  record(traceId: string, degradation: SignalDegradation): void {
    console.warn(JSON.stringify({ event: 'signal_degraded', traceId, rule: DEGRADATION_VERSION, ...degradation }));
  }

  overBudget(traceId: string, overrun: BudgetOverrun): void {
    console.warn(JSON.stringify({ event: 'dependency_budget_exceeded', traceId, budgetMs: SIGNAL_BUDGET_MS, ...overrun }));
  }
}

export const platformTimer: Timer = { after: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) };
