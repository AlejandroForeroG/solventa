import type { Signal, SignalScope } from '../../domain/signal';
import { ProviderFailure } from '../../application/ports/signal-sources';
import type { ProviderFailureCode } from '../../application/ports/signal-sources';

// What every provider adapter must produce for each scope, whatever the provider's own format.
export type SignalData = {
  income_obligations_12m: { monthlyIncomeCop: number; monthlyObligationsCop: number };
  payment_history_score: { score: number; latePayments12m: number };
  affiliation_regime: { regime: 'contributory' | 'subsidized' | 'special'; active: boolean };
  identity_validation: { verified: boolean };
};

export type ProviderResponse = { status: number; body: unknown };
// The transport to one provider: a simulated source today, an HTTP client when a real provider is contracted.
export type ProviderSource = (scope: SignalScope, subjectToken: string, signal: AbortSignal) => Promise<ProviderResponse>;
export type ProviderCall = { provider: string; source: ProviderSource; deadlineMs: number; translate: (scope: SignalScope, body: unknown) => Signal };

export const DEFAULT_DEADLINE_MS = 700;

export const invalidResponse = () => new ProviderFailure('invalid_response');
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidResponse();
  return value;
}

export function signalOf<S extends SignalScope>(scope: S, capturedAt: unknown, data: SignalData[S]): Signal {
  return { scope, capturedAt: instant(capturedAt), data };
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

// Date.parse silently rolls 2026-02-30 over to March 2, so the calendar date must round-trip.
function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Providers report either an instant or a Bogotá calendar date; a signal always carries a UTC instant.
function instant(value: unknown): string {
  if (typeof value !== 'string') throw invalidResponse();
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00-05:00` : value;
  const parts = TIMESTAMP.exec(text);
  const time = Date.parse(text);
  if (!parts || !isCalendarDate(Number(parts[1]), Number(parts[2]), Number(parts[3])) || Number.isNaN(time)) throw invalidResponse();
  return new Date(time).toISOString();
}

function failureForStatus(status: number): ProviderFailureCode | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'unavailable';
  return 'invalid_response';
}

export async function callProvider(call: ProviderCall, subjectToken: string, scope: SignalScope, traceId: string): Promise<Signal> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      call.source(scope, subjectToken, controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProviderFailure('timeout')), call.deadlineMs); })
    ]);
    const failure = failureForStatus(response.status);
    if (failure) throw new ProviderFailure(failure);
    return call.translate(scope, response.body);
  } catch (error) {
    const code = error instanceof ProviderFailure ? error.code : 'unavailable';
    // Only normalized values: the subject token and the provider's message stay out of the logs.
    console.error(JSON.stringify({ event: 'signal_provider_failed', traceId, provider: call.provider, scope, code }));
    throw new ProviderFailure(code);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
