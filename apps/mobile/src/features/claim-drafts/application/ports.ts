import type { DraftCommand, DraftEntry, DraftOwner, DraftVersion, SyncReply } from '../domain/draft';

export interface DraftStorage {
  unlock(): Promise<void>;
  lock(): void;
  read(owner?: DraftOwner): Promise<{ owner: DraftOwner; entries: DraftEntry[] } | null>;
  write(owner: DraftOwner, entries: readonly DraftEntry[]): Promise<void>;
  clear(): Promise<void>;
}
export interface DraftApi {
  evidence(policyId: string): Promise<{ claimId: string; fileId: string; contentType: string; createdAt: string }[]>;
  list(owner: DraftOwner): Promise<DraftVersion[]>;
  get(draftId: string): Promise<DraftVersion>;
  sync(draftId: string, command: DraftCommand, owner: DraftOwner): Promise<SyncReply>;
}
