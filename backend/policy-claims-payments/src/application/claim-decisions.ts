import type { ClaimDecisionInput } from '../domain/claim-decision';

export type ClaimDecisionActor = { clientId: string; traceId: string; expiresAt: string; subjectToken?: string };
export type ClaimDecisionResult =
  | { status: 'ok'; decisionId: string; state: 'approved' | 'rejected'; replayed: boolean }
  | { status: 'not_found' | 'conflict' | 'invalid_evidence' };

export interface ClaimDecisionStore {
  decide(claimId: string, input: ClaimDecisionInput, actor: ClaimDecisionActor, idempotencyKey: string): Promise<ClaimDecisionResult>;
}

export class ClaimDecisions {
  constructor(private readonly store: ClaimDecisionStore, private readonly clock: { now(): Date }) {}
  async decide(claimId: string, input: ClaimDecisionInput, actor: ClaimDecisionActor, idempotencyKey: string): Promise<ClaimDecisionResult> {
    if (!(Date.parse(actor.expiresAt) > this.clock.now().getTime())) throw new Error('claims_authorization_expired');
    const result = await this.store.decide(claimId, input, actor, idempotencyKey);
    if (!(Date.parse(actor.expiresAt) > this.clock.now().getTime())) throw new Error('claims_authorization_expired');
    return result;
  }
}
