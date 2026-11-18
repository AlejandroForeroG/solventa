import { canonicalAssistanceRequest, MAX_LISTED_REQUESTS, roundCoordinate, type AssistancePlace, type AssistanceRequestInput, type AssistanceRequestRecord } from '../domain/assistance-request';
import type { AssistanceDirectory, AssistanceOwner, AssistanceRequestStore } from './ports/assistance-request';
import type { ReportDigest } from './ports/claim-report';

export type CreateRequestResult = { status: 'created' | 'replayed'; request: AssistanceRequestRecord }
  | { status: 'provider_not_found' | 'directory_unavailable' | 'idempotency_conflict' };

export class AssistanceRequests {
  constructor(private readonly store: AssistanceRequestStore, private readonly directory: AssistanceDirectory, private readonly digest: ReportDigest,
    private readonly newReference: () => string) {}

  async create(owner: AssistanceOwner, input: AssistanceRequestInput, idempotencyKey: string, traceId: string): Promise<CreateRequestResult> {
    const provider = this.directory.find(input.providerId);
    if (provider === 'unavailable') return { status: 'directory_unavailable' };
    if (!provider) return { status: 'provider_not_found' };
    const place: AssistancePlace = input.place.kind === 'device'
      ? { kind: 'device', latitude: roundCoordinate(input.place.latitude), longitude: roundCoordinate(input.place.longitude) }
      : { kind: 'address', address: input.place.address };
    const requestHash = await this.digest.sha256Hex(canonicalAssistanceRequest(provider.id, place));
    return this.store.create({ owner, provider, place, idempotencyKey, requestHash, traceId, newReference: this.newReference });
  }

  get(owner: AssistanceOwner, id: string) { return this.store.get(owner, id); }
  list(owner: AssistanceOwner) { return this.store.listOwn(owner, MAX_LISTED_REQUESTS); }
}
