import { protectedPolicyCache } from '../../features/policy-cache/adapters/secure-policy-store';
import { protectedDraftStorage } from '../../features/claim-drafts/adapters/native-draft-storage';

// Both stores join Authentication's existing durable logout/account/environment clearing path.
export const localBusinessData = {
  async clear(): Promise<void> {
    protectedPolicyCache.lock(); protectedDraftStorage.lock();
    const results = await Promise.allSettled([protectedPolicyCache.clear(), protectedDraftStorage.clear()]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  },
};
