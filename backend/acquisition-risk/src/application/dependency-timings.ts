import type { Clock } from './ports/platform';

export type DependencyCall = { name: string; durationMs: number; outcome: 'ok' | 'failed' };

// How long each dependency took within one request, so the request's log line can name the slowest one.
export class DependencyTimings {
  private readonly calls: DependencyCall[] = [];

  constructor(private readonly clock: Clock) {}

  async measure<T>(name: string, call: () => Promise<T>): Promise<T> {
    const startedAt = this.clock.now().getTime();
    let outcome: DependencyCall['outcome'] = 'ok';
    try {
      return await call();
    } catch (error) {
      outcome = 'failed';
      throw error;
    } finally {
      this.record(name, this.clock.now().getTime() - startedAt, outcome);
    }
  }

  record(name: string, durationMs: number, outcome: DependencyCall['outcome']): void {
    this.calls.push({ name, durationMs, outcome });
  }

  summary(): { dominant: string | null; dependencies: DependencyCall[] } {
    const slowest = this.calls.reduce<DependencyCall | null>((slowest, call) => !slowest || call.durationMs > slowest.durationMs ? call : slowest, null);
    return { dominant: slowest?.name ?? null, dependencies: [...this.calls] };
  }
}
