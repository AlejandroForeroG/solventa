import { VerificationApiFailure } from '../domain/verification';
import type { Fixture, Locale, Step, Terms, Verification } from '../domain/verification';
import type { VerificationApi, VerificationCommand } from './ports';

export type VerificationSnapshot = {
  loaded: boolean; busy: boolean; verification: Verification | null; terms: Terms | null; fixtures: Fixture[];
  error?: string; traceId?: string; retryPending: boolean;
};
const empty = (): VerificationSnapshot => ({ loaded: false, busy: false, verification: null, terms: null, fixtures: [], retryPending: false });
export class IdentityVerification {
  private snapshot = empty();
  private listeners = new Set<() => void>();
  private generation = 0;
  private enabled = true;
  private pending: { command: VerificationCommand; key: string } | null = null;
  constructor(private readonly api: VerificationApi, private readonly locale: Locale, private readonly newKey: () => string) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(value: Partial<VerificationSnapshot>) { this.snapshot = { ...this.snapshot, ...value }; this.listeners.forEach(listener => listener()); }
  lock = () => { this.enabled = false; this.generation++; this.pending = null; this.snapshot = empty(); this.listeners.forEach(listener => listener()); };
  activate = () => { this.enabled = true; };
  load = async () => {
    if (!this.enabled || this.snapshot.busy) return;
    const generation = this.generation;
    this.publish({ busy: true, error: undefined, traceId: undefined });
    try {
      const [verification, terms, fixtures] = await Promise.all([this.api.current(), this.api.terms(this.locale), this.api.fixtures()]);
      if (!this.enabled || generation !== this.generation) return;
      // A server intent survives a process restart. Resume its exact request instead of inventing another evaluation.
      if (!this.pending && verification?.pendingEvaluation) this.pending = { key: verification.pendingEvaluation.idempotencyKey,
        command: { action: 'evaluate', id: verification.id, body: { expectedVersion: verification.pendingEvaluation.expectedVersion } } };
      this.publish({ loaded: true, verification, terms, fixtures, retryPending: Boolean(this.pending) });
    } catch (error) { if (this.enabled && generation === this.generation) this.failure(error); }
    finally { if (this.enabled && generation === this.generation) this.publish({ busy: false }); }
  };
  grant = (accepted: boolean) => {
    if (!accepted || !this.snapshot.terms) return Promise.resolve();
    return this.start({ action: 'grant', body: { textVersion: this.snapshot.terms.textVersion, locale: this.locale } });
  };
  save = (step: Step, fixture: Fixture) => {
    const current = this.snapshot.verification;
    if (!current || fixture.step !== step) return Promise.resolve();
    return this.start({ action: 'step', id: current.id, step,
      body: { reference: fixture.reference, sha256: fixture.sha256, corpusVersion: fixture.corpusVersion, expectedVersion: current.version } });
  };
  evaluate = () => this.versioned('evaluate');
  assist = () => this.versioned('assistance');
  revoke = () => {
    const current = this.snapshot.verification;
    if (!this.enabled || this.snapshot.busy || !current) return Promise.resolve();
    // Revocation is available even after an uncertain evaluation response; the old intent cannot finalize afterward.
    this.pending = null;
    return this.start({ action: 'revoke', id: current.id, body: {} });
  };
  private versioned(action: 'evaluate' | 'assistance') {
    const current = this.snapshot.verification;
    return current ? this.start({ action, id: current.id, body: { expectedVersion: current.version } }) : Promise.resolve();
  }
  private start(command: VerificationCommand) {
    if (!this.enabled || this.snapshot.busy || this.pending || !this.snapshot.loaded) return Promise.resolve();
    this.pending = { command, key: this.newKey() };
    return this.retry();
  }
  retry = async () => {
    if (!this.enabled || this.snapshot.busy || !this.pending) return;
    const pending = this.pending; const generation = this.generation;
    this.publish({ busy: true, error: undefined, traceId: undefined, retryPending: false });
    try {
      const verification = await this.api.execute(pending.command, pending.key);
      if (!this.enabled || generation !== this.generation) return;
      this.pending = null;
      this.publish({ verification, retryPending: false });
    } catch (error) {
      if (!this.enabled || generation !== this.generation) return;
      if (error instanceof VerificationApiFailure && !error.uncertain) {
        this.pending = null;
        if (error.verification) this.publish({ verification: error.verification });
        else {
          // A definite conflict or inactive consent requires authoritative progress before another action.
          try {
            const verification = await this.api.current();
            if (!this.enabled || generation !== this.generation) return;
            this.publish({ verification });
          } catch { if (this.enabled && generation === this.generation) this.publish({ loaded: false, verification: null }); }
          if (!this.enabled || generation !== this.generation) return;
        }
      }
      this.failure(error);
    } finally { if (this.enabled && generation === this.generation) this.publish({ busy: false, retryPending: Boolean(this.pending) }); }
  };
  private failure(error: unknown) {
    this.publish({ error: error instanceof VerificationApiFailure ? error.code : 'unavailable',
      traceId: error instanceof VerificationApiFailure ? error.traceId : undefined, retryPending: Boolean(this.pending) });
  }
}
