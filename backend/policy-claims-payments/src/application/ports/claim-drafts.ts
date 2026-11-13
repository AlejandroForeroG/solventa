import type { DraftCommand, DraftResult, DraftVersion } from '../../domain/claim-draft';
import type { ReportOwner } from './claim-report';

export interface ClaimDraftStore {
  evidence(owner: ReportOwner, policyId: string): Promise<{ claimId: string; fileId: string; contentType: string; createdAt: string }[]>;
  list(owner: ReportOwner): Promise<DraftVersion[]>;
  get(owner: ReportOwner, draftId: string): Promise<DraftVersion | null>;
  sync(input: { owner: ReportOwner; draftId: string; command: DraftCommand; requestHash: string; traceId: string }): Promise<DraftResult>;
}
