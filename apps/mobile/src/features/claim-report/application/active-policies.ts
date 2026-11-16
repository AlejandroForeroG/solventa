import type { CachedPolicy } from '../../policy-cache/domain/cached-policy';

export type PolicyOptions = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; policies: CachedPolicy[]; partial: boolean };

// The policies a report can be about: issued and in force. The server checks the same rule and never trusts this list.
// The list route returns only the most recent policies, so `partial` tells the screen that older ones were not read.
export class ActivePolicies {
  private snapshot: PolicyOptions = { status: 'loading' };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly list: () => Promise<{ policies: CachedPolicy[]; hasMore: boolean }>, private readonly inForce: (policy: CachedPolicy, now: number) => boolean, private readonly now: () => number) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;

  async refresh(): Promise<void> {
    this.emit({ status: 'loading' });
    try {
      const { policies, hasMore } = await this.list();
      this.emit({ status: 'ready', policies: policies.filter(policy => this.inForce(policy, this.now())), partial: hasMore });
    } catch { this.emit({ status: 'failed' }); }
  }

  private emit(snapshot: PolicyOptions) {
    this.snapshot = snapshot;
    for (const listener of [...this.listeners]) listener();
  }
}
