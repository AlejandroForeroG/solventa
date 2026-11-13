import { parseRequirementFile, parseRequirementResponse, parseReview, type ClaimNotice, type Expert, type RequirementFile, type RequirementResponse, type ReviewCommand } from '../domain/claim-review';
import type { ClaimState } from '../domain/claims';
import type { ClaimDecisionActor } from './claim-decisions';
import type { ClaimEvidenceStore, EvidenceBody, ReportOwner } from './ports/claim-report';

export type CaseAccess = { kind: 'analyst'; actor: ClaimDecisionActor } | { kind: 'customer'; actor: ReportOwner };
export type CaseEvidence = { id: string; contentType: string; byteSize: number; verifiedAt: string };
export type CaseRequirement = { id: string; details: string; deadline: string; status: 'pending' | 'received'; responseText: string | null; receivedAt: string | null; evidenceIds: string[] };
export type OwnedCase = { claimId: string; claimNumber: string; state: ClaimState };
export type CaseRecord = {
  claimNumber: string; policyId: string; state: ClaimState; occurredAt: string; eventType: string | null; place: string | null; description: string | null;
  access: 'assigned' | 'unassigned' | 'customer'; requiredEvidence: number; evidence: CaseEvidence[]; requirements: CaseRequirement[];
  history: { id: string; action: string; at: string; state: string; reason: string | null; expert: Expert | null; actorId: string | null }[];
  notices: { id: string; action: ClaimNotice; at: string }[];
};
export type ReviewOutcome = { status: 'ok'; actionId: string; state: ClaimState; replayed: boolean }
  | { status: 'not_found' | 'conflict' | 'invalid_evidence' | 'invalid_request' };

export interface ClaimReviewStore {
  owned(owner: ReportOwner, traceId: string): Promise<OwnedCase[]>;
  detail(claimId: string, access: CaseAccess, traceId: string): Promise<CaseRecord | null>;
  evidence(claimId: string, fileId: string, access: CaseAccess, traceId: string): Promise<(CaseEvidence & { key: string; sha256: string }) | null>;
  review(claimId: string, actor: ClaimDecisionActor, command: ReviewCommand, key: string, expert?: Expert): Promise<ReviewOutcome>;
  respond(claimId: string, requirementId: string, owner: ReportOwner, response: RequirementResponse, key: string, traceId: string): Promise<ReviewOutcome>;
  prepareFile(claimId: string, requirementId: string, owner: ReportOwner, file: RequirementFile, traceId: string):
    Promise<{ status: 'pending' | 'verified'; key: string } | { status: 'not_found' | 'conflict' }>;
  verifyFile(claimId: string, requirementId: string, owner: ReportOwner, fileId: string, traceId: string): Promise<boolean>;
}

export class ClaimReview<Body extends EvidenceBody = EvidenceBody> {
  constructor(private readonly store: ClaimReviewStore, private readonly storage: ClaimEvidenceStore<Body> | undefined,
    private readonly experts: () => Expert[]) {}

  detail(claimId: string, access: CaseAccess, traceId: string) {
    return this.store.detail(claimId, access, traceId);
  }

  evidence(claimId: string, fileId: string, access: CaseAccess, traceId: string) {
    return this.store.evidence(claimId, fileId, access, traceId);
  }

  owned(owner: ReportOwner, traceId: string) { return this.store.owned(owner, traceId); }

  directory() { return this.experts(); }

  async review(claimId: string, actor: ClaimDecisionActor, input: unknown, key: string): Promise<ReviewOutcome> {
    const command = parseReview(input);
    if (!command) return { status: 'invalid_request' };
    const expert = command.action === 'assign_expert' ? this.experts().find(item => item.id === command.expertId) : undefined;
    if (command.action === 'assign_expert' && !expert) return { status: 'invalid_request' };
    return this.store.review(claimId, actor, command, key, expert);
  }

  async respond(claimId: string, requirementId: string, owner: ReportOwner, input: unknown, key: string, traceId: string): Promise<ReviewOutcome> {
    const response = parseRequirementResponse(input);
    if (!response) return { status: 'invalid_request' };
    return this.store.respond(claimId, requirementId, owner, response, key, traceId);
  }

  async receive(claimId: string, requirementId: string, owner: ReportOwner, declaration: unknown, body: Body | null, traceId: string) {
    const file = parseRequirementFile(declaration);
    if (!body || !file || !this.storage) {
      await body?.cancel().catch(() => {});
      return !file || !body ? 'invalid_request' : 'evidence_unavailable';
    }
    const target = await this.store.prepareFile(claimId, requirementId, owner, file, traceId);
    if (target.status !== 'pending') {
      await body.cancel().catch(() => {});
      return target.status;
    }
    const stored = await this.storage.put(target.key, body, file);
    if (stored !== 'stored') return stored;
    return await this.store.verifyFile(claimId, requirementId, owner, file.fileId, traceId) ? 'verified' : 'conflict';
  }
}
