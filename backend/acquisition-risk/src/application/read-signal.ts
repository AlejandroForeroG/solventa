import { CONFIDENCE, defaultSignal, overallConfidence, SIGNAL_FRESHNESS_MS, SIGNAL_SCOPES } from '../domain/signal';
import type { Signal, SignalScope } from '../domain/signal';
import type { ConsentCheck, ConsentDenial, ConsentGuard } from './ports/consent-guard';
import type { Clock, Timer } from './ports/platform';
import { ProviderFailure, SIGNAL_DEADLINE_MS } from './ports/signal-sources';
import type { DegradationTrace, SignalDegradation, SignalProvider, SignalSnapshots } from './ports/signal-sources';

export type SignalResult =
  | { status: 'available'; signal: Signal; consentId: string }
  | { status: 'degraded'; signal: Signal; consentId: string; degradation: SignalDegradation }
  | { status: 'denied'; reason: ConsentDenial };

type SignalRequest = { subjectToken: string; scope: SignalScope; traceId: string };
type VerifiedConsent = Extract<ConsentCheck, { allowed: true }>;

// The only way to reach a source or stored copy. Standalone reads check consent here; composed offer reads
// receive the current four-scope authorization already checked by their boundary.
export class ReadSignal {
  constructor(private readonly deps: { guard: ConsentGuard; provider: SignalProvider; snapshots: SignalSnapshots; clock: Clock; timer: Timer; trace: DegradationTrace;
    background?: { waitUntil(work: Promise<unknown>): void } }) {}

  async execute(input: SignalRequest): Promise<SignalResult> {
    return this.executeResult(input, true);
  }

  private async executeResult(input: SignalRequest, recordDegradation: boolean): Promise<SignalResult> {
    const consent = await this.deps.guard.verify(input.subjectToken, input.scope, input.traceId);
    if (!consent.allowed) return { status: 'denied', reason: consent.reason };
    return this.executeAuthorizedResult({ ...input, consent }, recordDegradation);
  }

  // Offer creation already verifies the same four scopes atomically in Identity. Reusing that answer here
  // separates provider degradation from consent and avoids four redundant service-binding calls.
  async executeAuthorized(input: SignalRequest & { consent: VerifiedConsent }): Promise<SignalResult> {
    return this.executeAuthorizedResult(input, true);
  }

  private async executeAuthorizedResult(input: SignalRequest & { consent: VerifiedConsent }, recordDegradation: boolean): Promise<SignalResult> {
    try {
      const signal = await this.readWithinDeadline(input);
      await this.remember(input, signal);
      return { status: 'available', signal, consentId: input.consent.consentId };
    } catch (error) {
      const failure = error instanceof ProviderFailure ? error.code : 'unavailable';
      return this.substitute(input, input.consent.consentId, failure, recordDegradation);
    }
  }

  // The four sources are read in parallel: a failing one never delays or blocks the others.
  async executeAll(input: { subjectToken: string; traceId: string }) {
    const results = await Promise.all(SIGNAL_SCOPES.map(scope => this.executeResult({ ...input, scope }, false)));
    return this.finalizeParallel(input.traceId, results);
  }

  async executeAllAuthorized(input: { subjectToken: string; traceId: string; consent: VerifiedConsent }) {
    const results = await Promise.all(SIGNAL_SCOPES.map(scope => this.executeAuthorizedResult({ ...input, scope }, false)));
    return this.finalizeParallel(input.traceId, results);
  }

  private finalizeParallel(traceId: string, results: SignalResult[]) {
    const now = this.deps.clock.now();
    const finalized = results.map(result => {
      if (result.status !== 'degraded' || result.degradation.substitute !== 'stored_copy') return result;
      const capturedAt = Date.parse(result.signal.capturedAt);
      if (Number.isFinite(capturedAt) && capturedAt <= now.getTime() && now.getTime() - capturedAt < SIGNAL_FRESHNESS_MS) return result;
      const degradation: SignalDegradation = { ...result.degradation, substitute: 'default', confidence: CONFIDENCE.default };
      return { ...result, signal: defaultSignal(result.signal.scope, now), degradation };
    });
    for (const result of finalized) if (result.status === 'degraded') this.deps.trace.record(traceId, result.degradation);
    return { results: finalized, confidence: overallConfidence(finalized.map(confidenceOf)) };
  }

  // The adapter already enforces this limit; repeating it here keeps a provider that ignores it from holding the read.
  private readWithinDeadline(input: SignalRequest): Promise<Signal> {
    return this.withinDeadline(this.deps.provider.read(input.subjectToken, input.scope, input.traceId));
  }

  private withinDeadline<T>(work: Promise<T>): Promise<T> {
    const expired = this.deps.timer.after(SIGNAL_DEADLINE_MS).then((): never => { throw new ProviderFailure('timeout'); });
    return Promise.race([work, expired]);
  }

  private async remember(input: SignalRequest & { consent: VerifiedConsent }, signal: Signal): Promise<void> {
    const capturedAt = Date.parse(signal.capturedAt);
    if (!Number.isFinite(capturedAt)) return;
    const validUntil = new Date(Math.min(capturedAt + SIGNAL_FRESHNESS_MS, Date.parse(input.consent.expiresAt))).toISOString();
    if (Date.parse(validUntil) <= capturedAt) return;
    // Snapshot storage is a cache, not another provider dependency. A failed write must not discard a live answer.
    const save = this.withinDeadline(this.deps.snapshots.save({ subjectToken: input.subjectToken, consentId: input.consent.consentId,
      consentVersion: input.consent.textVersion, validUntil, signal, traceId: input.traceId })).catch(() => {});
    if (this.deps.background) this.deps.background.waitUntil(save);
    else await save;
  }

  private async substitute(input: SignalRequest, consentId: string, failure: SignalDegradation['failure'], recordDegradation: boolean): Promise<SignalResult> {
    const copy = await this.validCopy(input, consentId);
    const degradation: SignalDegradation = { scope: input.scope, failure, substitute: copy ? 'stored_copy' : 'default', confidence: copy ? CONFIDENCE.stored_copy : CONFIDENCE.default };
    if (recordDegradation) this.deps.trace.record(input.traceId, degradation);
    return { status: 'degraded', signal: copy ?? defaultSignal(input.scope, this.deps.clock.now()), consentId, degradation };
  }

  // A provider failure may fall back to a copy, but only one captured under this same, still valid consent and not expired.
  private async validCopy(input: SignalRequest, consentId: string): Promise<Signal | null> {
    try {
      const copy = await this.withinDeadline(this.deps.snapshots.find(input.subjectToken, input.scope, consentId));
      return copy && copy.consentId === consentId && Date.parse(copy.validUntil) > this.deps.clock.now().getTime() ? copy.signal : null;
    } catch {
      return null; // a copy that cannot be read in time is the same as no copy
    }
  }
}

function confidenceOf(result: SignalResult): number {
  if (result.status === 'available') return CONFIDENCE.live;
  return result.status === 'degraded' ? result.degradation.confidence : 0;
}
