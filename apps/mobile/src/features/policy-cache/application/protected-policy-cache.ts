import { PolicyCacheFailure, maxCachedPolicies, maxSnapshotBytes } from '../domain/cached-policy';
import type { CachedPolicy, PolicySnapshot, PolicyStatus } from '../domain/cached-policy';

export type CacheOwner = { clientId: string; subjectToken: string };

export interface ProtectedStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}

type Dependencies = {
  store: ProtectedStore;
  installationId: () => Promise<string>;
  now: () => number;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses: readonly PolicyStatus[] = ['pending', 'charged', 'issued', 'refunding', 'refunded'];
const premium = /^(0|[1-9][0-9]{0,14})\.[0-9]{4}$/;
const isoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PolicyCacheFailure('invalid_policy');
  return value as Record<string, unknown>;
}

function instant(value: unknown): string {
  if (typeof value !== 'string' || !isoInstant.test(value) || Number.isNaN(Date.parse(value))) throw new PolicyCacheFailure('invalid_policy');
  return value;
}

// Copies only the allowed fields: anything else on the source object never reaches storage.
export function minimizePolicy(source: unknown): CachedPolicy {
  const data = record(source);
  const { policyId, status, currency } = data;
  if (typeof policyId !== 'string' || !uuid.test(policyId)) throw new PolicyCacheFailure('invalid_policy');
  if (!statuses.includes(status as PolicyStatus)) throw new PolicyCacheFailure('invalid_policy');
  if (typeof data.premium !== 'string' || !premium.test(data.premium) || currency !== 'COP') throw new PolicyCacheFailure('invalid_policy');
  return {
    policyId, status: status as PolicyStatus, premium: data.premium, currency,
    effectiveFrom: instant(data.effectiveFrom), effectiveUntil: instant(data.effectiveUntil),
  };
}

function isOwner(value: unknown): value is CacheOwner {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return typeof data.clientId === 'string' && uuid.test(data.clientId) && typeof data.subjectToken === 'string' && uuid.test(data.subjectToken);
}

export class ProtectedPolicyCache {
  constructor(private readonly deps: Dependencies) {}

  async save(owner: CacheOwner, sources: readonly unknown[]): Promise<PolicySnapshot> {
    if (!isOwner(owner)) throw new PolicyCacheFailure('invalid_policy');
    if (sources.length > maxCachedPolicies) throw new PolicyCacheFailure('too_large');
    const snapshot: PolicySnapshot = { syncedAt: this.deps.now(), policies: sources.map(minimizePolicy) };
    const value = JSON.stringify({ version: 1, installationId: await this.deps.installationId(), owner, snapshot });
    if (new TextEncoder().encode(value).length > maxSnapshotBytes) throw new PolicyCacheFailure('too_large');
    await this.deps.store.write(value);
    return snapshot;
  }

  // Reading asks for device authentication. A snapshot of another installation, owner or format is discarded, never shown.
  async read(owner: CacheOwner): Promise<PolicySnapshot | null> {
    const value = await this.deps.store.read();
    if (value === null) return null;
    const snapshot = await this.parse(value, owner);
    if (!snapshot) await this.deps.store.remove();
    return snapshot;
  }

  clear(): Promise<void> {
    return this.deps.store.remove();
  }

  private async parse(value: string, owner: CacheOwner): Promise<PolicySnapshot | null> {
    try {
      const data = record(JSON.parse(value));
      const stored = data.owner as CacheOwner;
      if (data.version !== 1 || data.installationId !== await this.deps.installationId()
        || !isOwner(stored) || stored.clientId !== owner.clientId || stored.subjectToken !== owner.subjectToken) return null;
      const saved = record(data.snapshot);
      if (typeof saved.syncedAt !== 'number' || !Number.isSafeInteger(saved.syncedAt) || !Array.isArray(saved.policies)
        || saved.policies.length > maxCachedPolicies) return null;
      return { syncedAt: saved.syncedAt, policies: saved.policies.map(minimizePolicy) };
    } catch {
      return null;
    }
  }
}
