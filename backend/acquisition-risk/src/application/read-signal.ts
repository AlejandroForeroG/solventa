import { CONFIDENCE, defaultSignal, overallConfidence, SIGNAL_SCOPES } from '../domain/signal';
import type { Signal, SignalScope } from '../domain/signal';
import type { ConsentDenial, ConsentGuard } from './ports/consent-guard';
import type { Clock, Timer } from './ports/platform';
import { ProviderFailure, SIGNAL_DEADLINE_MS } from './ports/signal-sources';
import type { DegradationTrace, SignalDegradation, SignalProvider, SignalSnapshots } from './ports/signal-sources';

export type SignalResult =
  | { status: 'available'; signal: Signal; consentId: string }
  | { status: 'degraded'; signal: Signal; consentId: string; degradation: SignalDegradation }
  | { status: 'denied'; reason: ConsentDenial };

type SignalRequest = { subjectToken: string; scope: SignalScope; traceId: string };

// The only way to reach a source or a stored copy of its data. Consent is checked first, on every call.
export class ReadSignal {
  constructor(private readonly deps: { guard: ConsentGuard; provider: SignalProvider; snapshots: SignalSnapshots; clock: Clock; timer: Timer; trace: DegradationTrace }) {}

  async execute(input: SignalRequest): Promise<SignalResult> {
    const consent = await this.deps.guard.verify(input.subjectToken, input.scope, input.traceId);
    if (!consent.allowed) return { status: 'denied', reason: consent.reason };
    try {
      return { status: 'available', signal: await this.readWithinDeadline(input), consentId: consent.consentId };
    } catch (error) {
      const failure = error instanceof ProviderFailure ? error.code : 'unavailable';
      return this.substitute(input, consent.consentId, failure);
    }
  }

  // The four sources are read in parallel: a failing one never delays or blocks the others.
  async executeAll(input: { subjectToken: string; traceId: string }) {
    const results = await Promise.all(SIGNAL_SCOPES.map(scope => this.execute({ ...input, scope })));
    return { results, confidence: overallConfidence(results.map(confidenceOf)) };
  }

  // The adapter already enforces this limit; repeating it here keeps a provider that ignores it from holding the read.
  private readWithinDeadline(input: SignalRequest): Promise<Signal> {
    const expired = this.deps.timer.after(SIGNAL_DEADLINE_MS).then((): never => { throw new ProviderFailure('timeout'); });
    return Promise.race([this.deps.provider.read(input.subjectToken, input.scope, input.traceId), expired]);
  }

  private async substitute(input: SignalRequest, consentId: string, failure: SignalDegradation['failure']): Promise<SignalResult> {
    const copy = await this.validCopy(input, consentId);
    const degradation: SignalDegradation = { scope: input.scope, failure, substitute: copy ? 'stored_copy' : 'default', confidence: copy ? CONFIDENCE.stored_copy : CONFIDENCE.default };
    this.deps.trace.record(input.traceId, degradation);
    return { status: 'degraded', signal: copy ?? defaultSignal(input.scope, this.deps.clock.now()), consentId, degradation };
  }

  // A provider failure may fall back to a copy, but only one captured under this same, still valid consent and not expired.
  private async validCopy(input: SignalRequest, consentId: string): Promise<Signal | null> {
    try {
      const copy = await this.deps.snapshots.find(input.subjectToken, input.scope);
      return copy && copy.consentId === consentId && Date.parse(copy.validUntil) > this.deps.clock.now().getTime() ? copy.signal : null;
    } catch {
      return null; // an unreadable copy is the same as no copy
    }
  }
}

function confidenceOf(result: SignalResult): number {
  if (result.status === 'available') return CONFIDENCE.live;
  return result.status === 'degraded' ? result.degradation.confidence : 0;
}
