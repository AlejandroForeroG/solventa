export type PolicyStatus = 'pending' | 'charged' | 'issued' | 'refunding' | 'refunded';

// The only policy fields that may rest on the device. The reviewed document, its hash, offer, payment and trace data stay on the server.
export type CachedPolicy = {
  policyId: string;
  status: PolicyStatus;
  premium: string;
  currency: 'COP';
  effectiveFrom: string;
  effectiveUntil: string;
};

export type PolicySnapshot = { syncedAt: number; policies: CachedPolicy[] };

export type PolicyCacheFailureKind = 'unavailable' | 'locked' | 'invalid_policy' | 'too_large' | 'not_removed';

export class PolicyCacheFailure extends Error {
  constructor(public readonly kind: PolicyCacheFailureKind) {
    super(kind);
    this.name = 'PolicyCacheFailure';
  }
}

// Keychain values can be rejected above roughly 2048 bytes on some iOS releases, so the snapshot is bounded below that.
export const maxCachedPolicies = 6;
export const maxSnapshotBytes = 1800;
