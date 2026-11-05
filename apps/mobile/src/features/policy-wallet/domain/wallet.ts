import type { CachedPolicy } from '../../policy-cache/domain/cached-policy';

export type WalletSource = 'online' | 'stored';

export type WalletSnapshot =
  | { status: 'locked'; failure?: 'denied' | 'no_device_lock' }
  | { status: 'loading' }
  | { status: 'ready'; source: WalletSource; syncedAt: number; policies: CachedPolicy[]; hasMore: boolean; stored: boolean }
  | { status: 'failed'; failure: 'unavailable' | 'no_copy' | 'unauthorized' };

export type PolicyApiFailureKind = 'unavailable' | 'invalid_response';

export class PolicyApiFailure extends Error {
  constructor(public readonly kind: PolicyApiFailureKind, public readonly traceId?: string) {
    super(kind);
    this.name = 'PolicyApiFailure';
  }
}

export type Validity = 'upcoming' | 'active' | 'expired';

// Computed from the device clock: offline there is no server to ask, and the screen says the data is a stored copy.
export function validityAt(policy: CachedPolicy, now: number): Validity {
  if (now < Date.parse(policy.effectiveFrom)) return 'upcoming';
  return now < Date.parse(policy.effectiveUntil) ? 'active' : 'expired';
}

// Policies have no human-readable number yet, so the reference is the start of their identifier.
export const policyReference = (policyId: string): string => `POL-${policyId.slice(0, 8).toUpperCase()}`;
