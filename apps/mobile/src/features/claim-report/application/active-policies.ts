import type { CachedPolicy } from '../../policy-cache/domain/cached-policy';
import type { PoliciesApi } from '../../policy-wallet/application/ports';

export type PolicyOptions = { status: 'loading' } | { status: 'failed' }
  | { status: 'ready'; policies: CachedPolicy[]; partial: boolean; page: number; nextCursor: string | null };

// The policies a report can be about: issued and in force. The server checks the same rule and never trusts this list.
// Each page stays bounded; a known requested policy uses the same owner-scoped list filter instead of being limited to the first page.
export class ActivePolicies {
  private snapshot: PolicyOptions = { status: 'loading' };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private cursors: (string | undefined)[] = [undefined];
  private policyId: string | undefined;

  constructor(private readonly list: PoliciesApi['list'], private readonly inForce: (policy: CachedPolicy, now: number) => boolean, private readonly now: () => number) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;

  async refresh(policyId?: string): Promise<void> {
    this.policyId = policyId;
    this.cursors = [undefined];
    await this.load();
  }

  nextPage = async () => {
    if (this.snapshot.status !== 'ready' || !this.snapshot.nextCursor) return;
    this.cursors = [...this.cursors, this.snapshot.nextCursor];
    await this.load();
  };

  previousPage = async () => {
    if (this.snapshot.status !== 'ready' || this.cursors.length <= 1) return;
    this.cursors = this.cursors.slice(0, -1);
    await this.load();
  };

  retry = async () => { if (this.snapshot.status === 'failed') await this.load(); };
  cancel = () => { this.generation++; };

  private async load(): Promise<void> {
    const generation = ++this.generation;
    this.emit({ status: 'loading' });
    try {
      const { policies, hasMore, nextCursor } = await this.list(this.policyId ? { policyId: this.policyId } : { cursor: this.cursors.at(-1) });
      if (generation === this.generation) this.emit({ status: 'ready', policies: policies.filter(policy => this.inForce(policy, this.now())), partial: hasMore,
        page: this.cursors.length, nextCursor });
    } catch { if (generation === this.generation) this.emit({ status: 'failed' }); }
  }

  private emit(snapshot: PolicyOptions) {
    this.snapshot = snapshot;
    for (const listener of [...this.listeners]) listener();
  }
}
