import type { Signal, SignalScope } from '../domain/signal';
import type { ConsentDenial, ConsentGuard } from './ports/consent-guard';
import type { SignalProvider, SignalSnapshots } from './ports/signal-sources';

export type SignalResult =
  | { status: 'available'; signal: Signal; consentId: string }
  | { status: 'degraded'; signal: Signal; consentId: string }
  | { status: 'denied'; reason: ConsentDenial }
  | { status: 'unavailable'; consentId: string };

// The only way to reach a source or a stored copy of its data. Consent is checked first, on every call.
export class ReadSignal {
  constructor(private readonly deps: { guard: ConsentGuard; provider: SignalProvider; snapshots: SignalSnapshots }) {}

  async execute(input: { subjectToken: string; scope: SignalScope; traceId: string }): Promise<SignalResult> {
    const { guard, provider, snapshots } = this.deps;
    const consent = await guard.verify(input.subjectToken, input.scope);
    if (!consent.allowed) return { status: 'denied', reason: consent.reason };
    try {
      return { status: 'available', signal: await provider.read(input.subjectToken, input.scope, input.traceId), consentId: consent.consentId };
    } catch {
      // A provider failure may fall back to a copy, but only one captured under this same, still valid consent.
      try {
        const copy = await snapshots.find(input.subjectToken, input.scope);
        if (copy && copy.consentId === consent.consentId) return { status: 'degraded', signal: copy.signal, consentId: consent.consentId };
      } catch { /* an unreadable copy is the same as no copy */ }
      return { status: 'unavailable', consentId: consent.consentId };
    }
  }
}
