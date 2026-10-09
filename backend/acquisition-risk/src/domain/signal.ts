// One scope per external source; the codes are the ones Identity records in a consent.
export const SIGNAL_SCOPES = ['income_obligations_12m', 'payment_history_score', 'affiliation_regime', 'identity_validation'] as const;
export type SignalScope = typeof SIGNAL_SCOPES[number];

export type Signal = {
  scope: SignalScope;
  capturedAt: string;
  data: Readonly<Record<string, string | number | boolean>>;
};
