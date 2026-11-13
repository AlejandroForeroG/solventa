import { canonicalDraftCommand, parseDraftCommand, type DraftResult } from '../domain/claim-draft';
import type { ClaimDraftStore } from './ports/claim-drafts';
import type { ReportDigest, ReportOwner } from './ports/claim-report';

export class ClaimDrafts {
  constructor(private readonly store: ClaimDraftStore, private readonly digest: ReportDigest) {}

  list(owner: ReportOwner) { return this.store.list(owner); }
  evidence(owner: ReportOwner, policyId: string) { return this.store.evidence(owner, policyId); }
  get(owner: ReportOwner, draftId: string) { return this.store.get(owner, draftId); }

  async sync(owner: ReportOwner, draftId: string, body: unknown, traceId: string): Promise<DraftResult | { status: 'invalid' }> {
    const command = parseDraftCommand(body);
    if (!command) return { status: 'invalid' };
    return this.store.sync({ owner, draftId, command, requestHash: await this.digest.sha256Hex(canonicalDraftCommand(draftId, command)), traceId });
  }
}
