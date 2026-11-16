import { protectedPolicyCache } from '../../policy-cache/adapters/secure-policy-store';
import type { CacheOwner } from '../../policy-cache/application/protected-policy-cache';
import { PolicyWallet } from '../application/policy-wallet';
import type { AuthenticatedSession } from '../application/ports';
import { createPoliciesApi } from './policies-api';

export function createPolicyWallet(baseUrl: string, session: AuthenticatedSession, owner?: CacheOwner) {
  return new PolicyWallet({ api: createPoliciesApi(baseUrl, session), cache: protectedPolicyCache, owner, now: Date.now });
}
