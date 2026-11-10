import type { CachedPolicy } from '../../policy-cache/domain/cached-policy';

export type PolicyOptions = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; policies: CachedPolicy[] };

// The policies a report can be about: issued and in force. The server checks the same rule and never trusts this list.
export class ActivePolicies {
  private snapshot: PolicyOptions = { status: 'loading' };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly list: () => Promise<{ policies: CachedPolicy[] }>, private readonly inForce: (policy: CachedPolicy, now: number) => boolean, private readonly now: () => number) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;

  async refresh(): Promise<void> {
    this.emit({ status: 'loading' });
    try {
      const { policies } = await this.list();
      this.emit({ status: 'ready', policies: policies.filter(policy => this.inForce(policy, this.now())) });
    } catch { this.emit({ status: 'failed' }); }
  }

  private emit(snapshot: PolicyOptions) {
    this.snapshot = snapshot;
    for (const listener of [...this.listeners]) listener();
  }
}
