import type { Signal, SignalScope, SignalSubstitute } from '../../domain/signal';

export const PROVIDER_FAILURES = ['timeout', 'unavailable', 'rate_limited', 'unauthorized', 'not_found', 'invalid_response'] as const;
export type ProviderFailureCode = typeof PROVIDER_FAILURES[number];

// Hard limit for one external source; an adapter enforces it and the use case does not trust it to.
export const SIGNAL_DEADLINE_MS = 700;

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

// A stored copy of a signal, tied to the consent under which it was captured and valid until `validUntil`.
export type SignalSnapshot = { consentId: string; validUntil: string; signal: Signal };
export type SignalSnapshotWrite = SignalSnapshot & { subjectToken: string; consentVersion: number; traceId: string };
export interface SignalSnapshots {
  find(subjectToken: string, scope: SignalScope, consentId: string): Promise<SignalSnapshot | null>;
  save(snapshot: SignalSnapshotWrite): Promise<void>;
  saveAll?(snapshots: readonly SignalSnapshotWrite[]): Promise<void>;
}

// What the trace records when a source is replaced: which one failed, why, what replaced it and how far to trust it.
export type SignalDegradation = { scope: SignalScope; failure: ProviderFailureCode; substitute: SignalSubstitute; confidence: number };
export interface DegradationTrace {
  record(traceId: string, degradation: SignalDegradation): void;
}
