import { protectedPolicyCache } from '../../policy-cache/adapters/secure-policy-store';
import type { DraftSync } from '../application/draft-sync';
import type { DraftOwner } from '../domain/draft';
import { draftDeviceFailure } from './draft-device-failure';

export async function openDraftWorkspace(sync: DraftSync, owner?: DraftOwner): Promise<void> {
  if (owner) { await sync.open(owner); return; }
  // A first offline draft can use only the last installation-bound owner, after the same system prompt as the wallet.
  try {
    await protectedPolicyCache.unlock();
    const saved = await protectedPolicyCache.readLatest();
    await sync.open(saved?.owner);
  } catch (error) { throw draftDeviceFailure(error); }
  finally { protectedPolicyCache.lock(); }
}
