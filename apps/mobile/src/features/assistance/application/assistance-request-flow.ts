import type { AssistanceProviderMatch, AssistanceRequestBody, AssistanceRequestView } from '@solventa/contracts';

import { AuthFailure } from '../../authentication/domain/session';

// Where the customer is: a position read on the device, which this request alone is authorized to carry, or an address typed and confirmed.
export type RequestPlace = { kind: 'device'; latitude: number; longitude: number } | { kind: 'address'; address: string };
export type RequestFailure = 'unauthorized' | 'forbidden' | 'invalid' | 'not_found' | 'conflict' | 'unavailable';

export class AssistanceRequestFailure extends Error {
  constructor(public readonly code: Exclude<RequestFailure, 'unauthorized' | 'forbidden'> | 'invalid_response') { super(code); this.name = 'AssistanceRequestFailure'; }
}

export interface AssistanceRequestApi {
  create(body: AssistanceRequestBody, idempotencyKey: string): Promise<AssistanceRequestView>;
  list(): Promise<AssistanceRequestView[]>;
}

export type RequestState =
  | { kind: 'idle' }
  | { kind: 'review'; provider: AssistanceProviderMatch; place: RequestPlace }
  | { kind: 'sending'; provider: AssistanceProviderMatch; place: RequestPlace }
  | { kind: 'failed'; provider: AssistanceProviderMatch; place: RequestPlace; failure: RequestFailure }
  | { kind: 'done'; request: AssistanceRequestView };
export type OwnRequests = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; requests: AssistanceRequestView[] };
export type Snapshot = { request: RequestState; own: OwnRequests };

const bodyOf = (provider: AssistanceProviderMatch, place: RequestPlace): AssistanceRequestBody => ({
  providerId: provider.id,
  place: place.kind === 'device' ? { kind: 'device', authorized: true, coordinates: { latitude: place.latitude, longitude: place.longitude } } : { kind: 'address', address: place.address },
});

// One request of the customer, from reviewing it to seeing it stored. The idempotency key is kept for the whole confirmation, so a retry after a failure
// or an uncertain answer returns the stored request instead of making another one; reviewing anew starts a new key.
export class AssistanceRequestFlow {
  private snapshot: Snapshot = { request: { kind: 'idle' }, own: { status: 'loading' } };
  private key: string | null = null;
  private sending = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: { api: AssistanceRequestApi; newKey: () => string }) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;

  // Choosing the provider is not asking: nothing leaves the phone until the customer confirms the review.
  review(provider: AssistanceProviderMatch, place: RequestPlace) {
    if (this.sending) return;
    this.key = null;
    this.set({ kind: 'review', provider, place });
  }

  cancel() {
    if (this.sending) return;
    this.key = null;
    this.set({ kind: 'idle' });
  }

  async confirm(): Promise<void> {
    const state = this.snapshot.request;
    if (this.sending || (state.kind !== 'review' && state.kind !== 'failed')) return;
    const { provider, place } = state;
    this.sending = true;
    const key = this.key ??= this.deps.newKey();
    this.set({ kind: 'sending', provider, place });
    try {
      const request = await this.deps.api.create(bodyOf(provider, place), key);
      this.key = null;
      this.set({ kind: 'done', request });
      await this.refresh();
    } catch (error) {
      // A failed or uncertain send is never shown as a request that exists: the customer can retry with the same key.
      const failure = failureOf(error);
      // A refusal the same key would meet again, or a key already used for another request, is not retried with it.
      if (failure === 'conflict' || failure === 'invalid' || failure === 'not_found') this.key = null;
      this.set({ kind: 'failed', provider, place, failure });
    } finally { this.sending = false; }
  }

  async refresh(): Promise<void> {
    try { this.set(this.snapshot.request, { status: 'ready', requests: await this.deps.api.list() }); }
    catch { this.set(this.snapshot.request, { status: 'failed' }); }
  }

  private set(request: RequestState, own: OwnRequests = this.snapshot.own) {
    this.snapshot = { request, own };
    for (const listener of [...this.listeners]) listener();
  }
}

function failureOf(error: unknown): RequestFailure {
  if (error instanceof AuthFailure) return error.kind === 'forbidden' ? 'forbidden' : 'unauthorized';
  if (error instanceof AssistanceRequestFailure) return error.code === 'invalid_response' ? 'unavailable' : error.code;
  return 'unavailable';
}
