import { assistanceSearchPath, parseAssistanceResults } from '@solventa/contracts';
import type { AssistanceSearchRequest } from '@solventa/contracts';

import { validateBaseUrl } from '../../authentication/adapters/solventa-session';
import { AuthFailure } from '../../authentication/domain/session';

type Session = { execute<T>(operation: (token: string) => Promise<T>): Promise<T> };

export function createAssistanceApi(baseUrl: string, session: Session, request: typeof fetch = fetch) {
  validateBaseUrl(baseUrl);
  return {
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
