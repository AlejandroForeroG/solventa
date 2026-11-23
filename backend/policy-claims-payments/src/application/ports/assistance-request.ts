import type { AssistanceMatch } from '../../domain/assistance-search';
import type { AssistancePlace, AssistanceRequestRecord } from '../../domain/assistance-request';

export type AssistanceOwner = { clientId: string; subjectToken: string };
export type CreateOutcome = { status: 'created' | 'replayed'; request: AssistanceRequestRecord } | { status: 'idempotency_conflict' };

export interface AssistanceRequestStore {
  // A repeated key with the same request returns the stored one; with another request it is a conflict. The reference is drawn again when a draw collides.
  create(input: { owner: AssistanceOwner; provider: Omit<AssistanceMatch, 'distanceKm'>; place: AssistancePlace; idempotencyKey: string; requestHash: string; traceId: string;
    newReference: () => string }): Promise<CreateOutcome>;
  // Always resolved through the owner: a request of another customer is the same as one that does not exist.
  get(owner: AssistanceOwner, id: string): Promise<AssistanceRequestRecord | null>;
  listOwn(owner: AssistanceOwner, limit: number): Promise<AssistanceRequestRecord[]>;
}

export interface AssistanceDirectory { find(providerId: string): Omit<AssistanceMatch, 'distanceKm'> | null | 'unavailable' }
