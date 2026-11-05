import type { CacheOwner } from '../../policy-cache/application/protected-policy-cache';
import type { CachedPolicy, PolicySnapshot } from '../../policy-cache/domain/cached-policy';

export interface AuthenticatedSession {
  execute<T>(operation: (accessToken: string) => Promise<T>): Promise<T>;
}

export interface PoliciesApi {
  list(): Promise<{ policies: CachedPolicy[]; hasMore: boolean }>;
}

export interface WalletCache {
  unlock(): Promise<void>;
  lock(): void;
  save(owner: CacheOwner, policies: readonly unknown[]): Promise<PolicySnapshot>;
  read(owner: CacheOwner): Promise<PolicySnapshot | null>;
}
