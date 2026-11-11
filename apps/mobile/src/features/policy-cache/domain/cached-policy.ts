export type PolicyProduct = 'vida_hipotecario' | 'flight_delay' | 'weather_event';

export type PolicyCoverage =
  | { kind: 'mortgage_life'; sumInsured: string }
  | { kind: 'flight_delay'; flightReference: string; thresholdMinutes: number; payoutAmount: string }
  | { kind: 'weather_event'; stationId: string; parameter: 'precipitation_24h'; unit: 'mm'; threshold: number; payoutAmount: string };

// The only policy fields that may rest on the device. The reviewed document, its hash, offer, payment and trace data stay on the server.
export type CachedPolicy = {
  policyId: string;
  product: PolicyProduct;
  premium: string;
  currency: 'COP';
  effectiveFrom: string;
  effectiveUntil: string;
  coverage: PolicyCoverage;
};

export type PolicySnapshot = { syncedAt: number; policies: CachedPolicy[] };

export type PolicyCacheFailureKind = 'unavailable' | 'locked' | 'invalid_policy' | 'too_large' | 'not_removed';

export class PolicyCacheFailure extends Error {
  constructor(public readonly kind: PolicyCacheFailureKind) {
    super(kind);
    this.name = 'PolicyCacheFailure';
  }
}

// Keychain values can be rejected above roughly 2048 bytes on some iOS releases, so the encoded snapshot is bounded below that.
export const maxCachedPolicies = 6;
export const maxSnapshotBytes = 1800;
