import { assistanceRequestsPath, parseAssistanceRequestList, parseAssistanceRequestResponse } from '@solventa/contracts';
import type { AssistanceRequestBody, AssistanceRequestView } from '@solventa/contracts';

export type RequestFailure = 'forbidden' | 'invalid' | 'not_found' | 'conflict' | 'unavailable';
export class RequestError extends Error {
  // 'unauthorized' is not a failure to show: the session is gone and the page leaves through its own path.
  readonly code: RequestFailure | 'unauthorized';
  constructor(code: RequestFailure | 'unauthorized') { super(code); this.code = code; this.name = 'RequestError'; }
}

const DEADLINE_MS = 12_000;

// One reading of every answer: the statuses of the contract are told apart, and a body that is not the promised shape is an outage, never a request that exists.
async function call<T>(init: RequestInit, read: (value: unknown) => T | null, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, DEADLINE_MS);
  try {
    const response = await fetch(assistanceRequestsPath, { ...init, credentials: 'same-origin', signal: controller.signal, headers: { Accept: 'application/json', ...init.headers } });
    if (response.status === 401) throw new RequestError('unauthorized');
    if (response.status === 403) throw new RequestError('forbidden');
    if (response.status === 400) throw new RequestError('invalid');
    if (response.status === 404) throw new RequestError('not_found');
    if (response.status === 409) throw new RequestError('conflict');
    if ((response.status !== 200 && response.status !== 201) || !response.headers.get('content-type')?.includes('application/json')) throw new RequestError('unavailable');
    const raw = await response.text();
    const value = raw.length <= 64 * 1024 ? read(JSON.parse(raw)) : null;
    if (value === null) throw new RequestError('unavailable');
    return value;
  } catch (error) {
    throw error instanceof RequestError ? error : new RequestError('unavailable');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export const createRequest = (body: AssistanceRequestBody, idempotencyKey: string, signal?: AbortSignal): Promise<AssistanceRequestView> =>
  call({ method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body) }, parseAssistanceRequestResponse, signal);
export const listRequests = (signal?: AbortSignal): Promise<AssistanceRequestView[]> => call({ method: 'GET' }, parseAssistanceRequestList, signal);
