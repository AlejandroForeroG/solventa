import { protectedPolicyCache } from '../../policy-cache/adapters/secure-policy-store';
import type { DraftSync } from '../application/draft-sync';
import type { DraftOwner } from '../domain/draft';

export async function openDraftWorkspace(sync: DraftSync, owner?: DraftOwner): Promise<void> {
  if (owner) { await sync.open(owner); return; }
  // A first offline draft can use only the last installation-bound owner, after the same system prompt as the wallet.
  await protectedPolicyCache.unlock();
  try {
    const saved = await protectedPolicyCache.readLatest();
    await sync.open(saved?.owner);
  } finally { protectedPolicyCache.lock(); }
}
