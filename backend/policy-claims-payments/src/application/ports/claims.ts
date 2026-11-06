import type { ClaimState, OpenClaimRecord } from '../../domain/claims';

export type ClaimQuery = { state?: ClaimState; overdue?: true; query?: string; before?: string };
export type ClaimReader = { clientId: string; traceId: string; expiresAt: string };
export type ClaimThresholds = { highDays: number; mediumDays: number; overdueDays: number };
export interface ClaimInboxStore {
  // One committed read that also records the access in the owner's audit log before releasing data.
  list(query: ClaimQuery, reader: ClaimReader, thresholds: ClaimThresholds): Promise<{ records: OpenClaimRecord[]; next: string | null }>;
}
