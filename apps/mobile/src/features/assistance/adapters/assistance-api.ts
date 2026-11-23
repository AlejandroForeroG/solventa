import { assistanceRequestsPath, assistanceSearchPath, parseAssistanceRequestList, parseAssistanceRequestResponse, parseAssistanceResults } from '@solventa/contracts';
import type { AssistanceRequestBody, AssistanceRequestView, AssistanceSearchRequest } from '@solventa/contracts';

import { validateBaseUrl } from '../../authentication/adapters/solventa-session';
import { AuthFailure } from '../../authentication/domain/session';
import { AssistanceRequestFailure } from '../application/assistance-request-flow';

type Session = { execute<T>(operation: (token: string) => Promise<T>): Promise<T> };

const REQUEST_DEADLINE_MS = 12_000;
const MAX_RESPONSE = 64 * 1024;

export function createAssistanceApi(baseUrl: string, session: Session, request: typeof fetch = fetch) {
  validateBaseUrl(baseUrl);
  // The request routes answer with the same few statuses: the session, the contract and the key are told apart, and anything else is an outage.
  const call = <T>(path: string, init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }, read: (value: unknown) => T | null) => session.execute(async token => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_DEADLINE_MS);
    try {
      const response = await request(baseUrl + path, { ...init, credentials: 'omit', signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...init.headers } });
      if (response.status === 401) throw new AuthFailure('unauthorized');
      if (response.status === 403) throw new AuthFailure('forbidden');
      if (response.status === 400) throw new AssistanceRequestFailure('invalid');
      if (response.status === 404) throw new AssistanceRequestFailure('not_found');
      if (response.status === 409) throw new AssistanceRequestFailure('conflict');
      if (response.status !== 200 && response.status !== 201) throw new AssistanceRequestFailure('unavailable');
      if (!response.headers.get('content-type')?.includes('application/json')) throw new AssistanceRequestFailure('invalid_response');
      const raw = await response.text();
      const value = raw.length <= MAX_RESPONSE ? read(JSON.parse(raw)) : null;
      if (value === null) throw new AssistanceRequestFailure('invalid_response');
      return value;
    } catch (error) {
      if (error instanceof AuthFailure || error instanceof AssistanceRequestFailure) throw error;
      // A network failure, a timeout or a malformed body is an outage: nothing is known about whether the request was stored.
      throw new AssistanceRequestFailure(error instanceof SyntaxError ? 'invalid_response' : 'unavailable');
    } finally { clearTimeout(timeout); }
  });
  return {
    createRequest: (body: AssistanceRequestBody, idempotencyKey: string): Promise<AssistanceRequestView> =>
      call(assistanceRequestsPath, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body) }, parseAssistanceRequestResponse),
    listRequests: (): Promise<AssistanceRequestView[]> => call(assistanceRequestsPath, { method: 'GET' }, parseAssistanceRequestList),
    search: (input: AssistanceSearchRequest, signal?: AbortSignal) => session.execute(async token => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, 12_000);
      try {
        const response = await request(baseUrl + assistanceSearchPath, {
          method: 'POST', credentials: 'omit', signal: controller.signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(input),
        });
        if (response.status === 401) throw new AuthFailure('unauthorized');
        if (response.status === 403) throw new AuthFailure('forbidden');
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('directory_unavailable');
        const raw = await response.text();
        const providers = raw.length <= 64 * 1024 ? parseAssistanceResults(JSON.parse(raw)) : null;
        if (!providers) throw new Error('invalid_response');
        return providers;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      }
    }),
  };
}
