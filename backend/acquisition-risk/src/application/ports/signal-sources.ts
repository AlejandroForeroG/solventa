import type { Signal, SignalScope } from '../../domain/signal';

export interface SignalProvider {
  read(subjectToken: string, scope: SignalScope, traceId: string): Promise<Signal>;
}

// A stored copy of a signal, tied to the consent under which it was captured.
export type SignalSnapshot = { consentId: string; signal: Signal };
export interface SignalSnapshots {
  find(subjectToken: string, scope: SignalScope): Promise<SignalSnapshot | null>;
}
