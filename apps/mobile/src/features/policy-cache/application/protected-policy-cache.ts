import { PolicyCacheFailure, maxCachedPolicies, maxSnapshotBytes } from '../domain/cached-policy';
import type { CachedPolicy, PolicyCoverage, PolicyProduct, PolicySnapshot } from '../domain/cached-policy';

export type CacheOwner = { clientId: string; subjectToken: string };

export interface ProtectedStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}

// Resolves when the user passes the device's own authentication (biometrics or the device code) and rejects with a PolicyCacheFailure otherwise.
export interface DeviceAuthentication {
  authenticate(): Promise<void>;
}

type Dependencies = {
  store: ProtectedStore;
  installationId: () => Promise<string>;
  authentication: DeviceAuthentication;
  now: () => number;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const premium = /^(0|[1-9][0-9]{0,14})\.[0-9]{4}$/;
const products: readonly PolicyProduct[] = ['vida_hipotecario', 'flight_delay'];

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PolicyCacheFailure('invalid_policy');
  return value as Record<string, unknown>;
}

function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new PolicyCacheFailure('invalid_policy');
  return value;
}

// Only the exact UTC form the server writes is accepted, so the compact encoding restores the same string.
function instant(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) throw new PolicyCacheFailure('invalid_policy');
  return value;
}

function coverageOf(product: PolicyProduct, value: unknown): PolicyCoverage {
  const data = record(value);
  if (product === 'vida_hipotecario' && data.kind === 'mortgage_life') return { kind: 'mortgage_life', sumInsured: text(data.sumInsured, premium) };
  if (product === 'flight_delay' && data.kind === 'flight_delay') {
    const { thresholdMinutes } = data;
    if (typeof thresholdMinutes !== 'number' || !Number.isSafeInteger(thresholdMinutes) || thresholdMinutes < 1) throw new PolicyCacheFailure('invalid_policy');
    return { kind: 'flight_delay', flightReference: text(data.flightReference, uuid), thresholdMinutes, payoutAmount: text(data.payoutAmount, premium) };
  }
  throw new PolicyCacheFailure('invalid_policy');
}

// Copies only the allowed fields: anything else on the source object never reaches storage.
export function minimizePolicy(source: unknown): CachedPolicy {
  const data = record(source);
  const product = data.product as PolicyProduct;
  if (!products.includes(product) || data.currency !== 'COP') throw new PolicyCacheFailure('invalid_policy');
  return {
    policyId: text(data.policyId, uuid), product, premium: text(data.premium, premium), currency: 'COP',
    effectiveFrom: instant(data.effectiveFrom), effectiveUntil: instant(data.effectiveUntil), coverage: coverageOf(product, data.coverage),
  };
}

// Arrays instead of objects keep six policies far below the keychain size limit.
function encodePolicy(policy: CachedPolicy): unknown[] {
  const common = [policy.policyId, policy.coverage.kind === 'mortgage_life' ? 0 : 1, policy.premium, Date.parse(policy.effectiveFrom), Date.parse(policy.effectiveUntil)];
  return policy.coverage.kind === 'mortgage_life' ? [...common, policy.coverage.sumInsured]
    : [...common, policy.coverage.flightReference, policy.coverage.thresholdMinutes, policy.coverage.payoutAmount];
}

function decodePolicy(value: unknown): CachedPolicy {
  if (!Array.isArray(value) || value.length < 6) throw new PolicyCacheFailure('invalid_policy');
  const [policyId, code, amount, from, until, ...rest] = value;
  if (typeof from !== 'number' || typeof until !== 'number') throw new PolicyCacheFailure('invalid_policy');
  const effective = { effectiveFrom: new Date(from).toISOString(), effectiveUntil: new Date(until).toISOString() };
  if (code === 0 && rest.length === 1) return minimizePolicy({ policyId, product: 'vida_hipotecario', premium: amount, currency: 'COP', ...effective, coverage: { kind: 'mortgage_life', sumInsured: rest[0] } });
  if (code === 1 && rest.length === 3) return minimizePolicy({ policyId, product: 'flight_delay', premium: amount, currency: 'COP', ...effective,
    coverage: { kind: 'flight_delay', flightReference: rest[0], thresholdMinutes: rest[1], payoutAmount: rest[2] } });
  throw new PolicyCacheFailure('invalid_policy');
}

function isOwner(value: unknown): value is CacheOwner {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return typeof data.clientId === 'string' && uuid.test(data.clientId) && typeof data.subjectToken === 'string' && uuid.test(data.subjectToken);
}

export class ProtectedPolicyCache {
  private unlocked = false;

  constructor(private readonly deps: Dependencies) {}

  // Opening the cache asks for the device authentication; the wallet locks it again when it is closed or backgrounded.
  async unlock(): Promise<void> {
    await this.deps.authentication.authenticate();
    this.unlocked = true;
  }

  lock(): void {
    this.unlocked = false;
  }

  async save(owner: CacheOwner, sources: readonly unknown[]): Promise<PolicySnapshot> {
    if (!isOwner(owner)) throw new PolicyCacheFailure('invalid_policy');
    if (sources.length > maxCachedPolicies) throw new PolicyCacheFailure('too_large');
    const snapshot: PolicySnapshot = { syncedAt: this.deps.now(), policies: sources.map(minimizePolicy) };
    const value = JSON.stringify({ v: 2, i: await this.deps.installationId(), o: [owner.clientId, owner.subjectToken], t: snapshot.syncedAt, p: snapshot.policies.map(encodePolicy) });
    if (new TextEncoder().encode(value).length > maxSnapshotBytes) throw new PolicyCacheFailure('too_large');
    await this.deps.store.write(value);
    return snapshot;
  }

  // A snapshot of another installation, owner or format is discarded, never shown.
  async read(owner: CacheOwner): Promise<PolicySnapshot | null> {
    if (!this.unlocked) throw new PolicyCacheFailure('locked');
    const value = await this.deps.store.read();
    if (value === null) return null;
    const snapshot = await this.parse(value, owner);
    if (!snapshot) await this.deps.store.remove();
    return snapshot;
  }

  clear(): Promise<void> {
    this.lock();
    return this.deps.store.remove();
  }

  private async parse(value: string, owner: CacheOwner): Promise<PolicySnapshot | null> {
    try {
      const data = record(JSON.parse(value));
      const stored = data.o;
      if (data.v !== 2 || data.i !== await this.deps.installationId() || !Array.isArray(stored)
        || stored[0] !== owner.clientId || stored[1] !== owner.subjectToken) return null;
      if (typeof data.t !== 'number' || !Number.isSafeInteger(data.t) || !Array.isArray(data.p) || data.p.length > maxCachedPolicies) return null;
      return { syncedAt: data.t, policies: data.p.map(decodePolicy) };
    } catch {
      return null;
    }
  }
}
