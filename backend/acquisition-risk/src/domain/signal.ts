// One scope per external source; the codes are the ones Identity records in a consent.
export const SIGNAL_SCOPES = ['income_obligations_12m', 'payment_history_score', 'affiliation_regime', 'identity_validation'] as const;
export type SignalScope = typeof SIGNAL_SCOPES[number];

export type Signal = {
  scope: SignalScope;
  capturedAt: string;
  data: Readonly<Record<string, string | number | boolean>>;
};

// Version of the substitute values and confidence levels below; a trace must say which one it applied.
export const DEGRADATION_VERSION = 'degradation-1';

export type SignalSubstitute = 'stored_copy' | 'default';

// Percentage of trust in a signal by origin. A default never came from the person, so it carries none.
export const CONFIDENCE = { live: 100, stored_copy: 60, default: 0 } as const;

// Stand-ins for a source that did not answer. None can favor the customer: the mortgage underwriting rule
// rejects every one of them (unverified identity, no affiliation, score under 600, debt over 50 % of income).
export const DEFAULT_SIGNAL_DATA = {
  income_obligations_12m: { monthlyIncomeCop: 1, monthlyObligationsCop: 1 },
  payment_history_score: { score: 0, latePayments12m: 12 },
  affiliation_regime: { regime: 'contributory', active: false },
  identity_validation: { verified: false }
} as const satisfies Record<SignalScope, Signal['data']>;

export function defaultSignal(scope: SignalScope, at: Date): Signal {
  return { scope, capturedAt: at.toISOString(), data: DEFAULT_SIGNAL_DATA[scope] };
}

export function overallConfidence(levels: readonly number[]): number {
  return levels.length === 0 ? 0 : Math.round(levels.reduce((sum, level) => sum + level, 0) / levels.length);
}
