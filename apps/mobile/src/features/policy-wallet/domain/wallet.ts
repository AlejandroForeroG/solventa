import type { AuthSnapshot } from '../../authentication/domain/session';
import type { CacheOwner } from '../../policy-cache/application/protected-policy-cache';
import type { CachedPolicy } from '../../policy-cache/domain/cached-policy';

export type WalletSource = 'online' | 'stored';

export type WalletSnapshot =
  | { status: 'locked'; failure?: 'denied' | 'no_device_lock' }
  | { status: 'loading' }
  | { status: 'ready'; source: WalletSource; syncedAt: number; policies: CachedPolicy[]; hasMore: boolean; stored: boolean }
  | { status: 'failed'; failure: 'unavailable' | 'no_copy' | 'unauthorized' | 'invalid_response' | 'integrity' | 'discard_pending' };

// `integrity` is the server refusing a policy whose sealed evidence does not verify: it is a rejection, never an outage.
export type PolicyApiFailureKind = 'unavailable' | 'invalid_response' | 'integrity';

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

export type WalletAccess = { mode: 'online'; owner: CacheOwner } | { mode: 'offline' };

// A verified session reads from the server. A session that exists on the device but cannot be verified because the server is unreachable
// may still open the last stored copy behind the device authentication. A revoked session is signed out by Authentication and never gets here.
export function walletAccessFor(auth: Pick<AuthSnapshot, 'status' | 'failure' | 'principal'>): WalletAccess | null {
  if (auth.status === 'authenticated' && auth.principal) return { mode: 'online', owner: auth.principal };
  if (auth.status === 'blocked' && auth.failure === 'unavailable') return { mode: 'offline' };
  return null;
}
