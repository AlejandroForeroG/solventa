import type { Signal, SignalScope } from '../../domain/signal';

export const PROVIDER_FAILURES = ['timeout', 'unavailable', 'rate_limited', 'unauthorized', 'not_found', 'invalid_response'] as const;
export type ProviderFailureCode = typeof PROVIDER_FAILURES[number];

// The only error a provider adapter may reject with: provider messages, codes and payloads never cross the port.
export class ProviderFailure extends Error {
  constructor(readonly code: ProviderFailureCode) {
    super(code);
    this.name = 'ProviderFailure';
  }
}

export interface SignalProvider {
  read(subjectToken: string, scope: SignalScope, traceId: string): Promise<Signal>;
}

// A stored copy of a signal, tied to the consent under which it was captured.
export type SignalSnapshot = { consentId: string; signal: Signal };
export interface SignalSnapshots {
  find(subjectToken: string, scope: SignalScope): Promise<SignalSnapshot | null>;
}
