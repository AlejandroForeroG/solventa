import { AuthFailure } from '../../authentication/domain/session';
import { PolicyCacheFailure } from '../../policy-cache/domain/cached-policy';
import type { CacheOwner } from '../../policy-cache/application/protected-policy-cache';
import { PolicyApiFailure } from '../domain/wallet';
import type { WalletSnapshot } from '../domain/wallet';
import type { PoliciesApi, WalletCache } from './ports';

// Without an owner the session could not be verified: the wallet only shows the last stored copy and never calls the server.
type Dependencies = { api: PoliciesApi; cache: WalletCache; owner?: CacheOwner; now: () => number };

// The server is the source of truth. The protected copy only keeps the last answer available, and says so.
export class PolicyWallet {
  private snapshot: WalletSnapshot = { status: 'locked' };
  private listeners = new Set<() => void>();
  private generation = 0;

  constructor(private readonly deps: Dependencies) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(snapshot: WalletSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  // The data is shown only after the device authentication, also when there is no connection.
  unlock = async () => {
    if (this.snapshot.status === 'loading') return;
    const generation = ++this.generation;
    try {
      await this.deps.cache.unlock();
    } catch (error) {
      if (generation === this.generation) this.publish({ status: 'locked', failure: error instanceof PolicyCacheFailure && error.kind === 'unavailable' ? 'no_device_lock' : 'denied' });
      return;
    }
    if (generation !== this.generation) return;
    if (this.deps.owner) await this.load(generation, this.deps.owner);
    else await this.showStoredCopy(generation);
  };

  // Only an unlocked wallet can reload.
  refresh = async () => {
    if (this.snapshot.status !== 'ready' && this.snapshot.status !== 'failed') return;
    if (this.deps.owner) await this.load(this.generation, this.deps.owner);
    else await this.showStoredCopy(this.generation);
  };

  private async load(generation: number, owner: CacheOwner) {
    this.publish({ status: 'loading' });
    try {
      const { policies, hasMore } = await this.deps.api.list();
      if (generation !== this.generation) return;
      let stored = true;
      try { await this.deps.cache.save(owner, policies); } catch { stored = false; }
      if (generation === this.generation) this.publish({ status: 'ready', source: 'online', syncedAt: this.deps.now(), policies, hasMore, stored });
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof AuthFailure) { this.publish({ status: 'failed', failure: 'unauthorized' }); return; }
      if (!(error instanceof PolicyApiFailure)) { this.publish({ status: 'failed', failure: 'unavailable' }); return; }
      // Only an outage falls back to the stored copy. A malformed answer or an integrity rejection stays a failure, so it is never reported as lost connectivity.
      if (error.kind !== 'unavailable') { this.publish({ status: 'failed', failure: error.kind }); return; }
      await this.showStoredCopy(generation);
    }
  }

  private async showStoredCopy(generation: number) {
    try {
      const { owner } = this.deps;
      const copy = owner ? await this.deps.cache.read(owner) : (await this.deps.cache.readLatest())?.snapshot ?? null;
      if (generation !== this.generation) return;
      this.publish(copy ? { status: 'ready', source: 'stored', syncedAt: copy.syncedAt, policies: copy.policies, hasMore: false, stored: true }
        : { status: 'failed', failure: 'no_copy' });
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof PolicyCacheFailure && error.kind === 'locked') this.publish({ status: 'locked' });
      // A removal owed from an ended session is still failing: the copy stays closed rather than shown.
      else this.publish({ status: 'failed', failure: error instanceof PolicyCacheFailure && error.kind === 'not_removed' ? 'discard_pending' : 'unavailable' });
    }
  }

  // Leaving the screen or backgrounding the app hides the data and requires the device authentication again.
  lock = () => {
    this.generation++;
    this.deps.cache.lock();
    this.publish({ status: 'locked' });
  };
}
