import { AuthFailure } from '../../authentication/domain/session';
import { validateBaseUrl } from '../../authentication/adapters/solventa-session';
import { parsePreferences } from '../domain/preferences';
import type { Matrix, Preferences } from '../domain/preferences';

type Session = { execute<T>(operation: (token: string) => Promise<T>): Promise<T> };
export class PreferencesApiFailure extends Error {
  constructor(readonly code: 'conflict' | 'unavailable' | 'invalid_response') { super(code); }
}

export function createPreferencesApi(baseUrl: string, session: Session, request: typeof fetch = fetch) {
  validateBaseUrl(baseUrl);
  const url = `${baseUrl}/api/v1/mobile/notification-preferences`;
  async function call(method: 'GET' | 'PUT', body?: { preferences: Matrix; expectedVersion: number }, key?: string): Promise<Preferences> {
    return session.execute(async token => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new PreferencesApiFailure('unavailable')); }, 12_000);
      });
      try {
        const load = async () => {
          const response = await request(url, { method, credentials: 'omit', signal: controller.signal,
            headers: { Accept: 'application/json', Authorization: `Bearer ${token}`,
              ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key ?? '' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}) });
          if (!response.headers.get('content-type')?.includes('application/json')) throw new PreferencesApiFailure('invalid_response');
          const raw = await response.text();
          if (raw.length > 8192) throw new PreferencesApiFailure('invalid_response');
          const data: unknown = JSON.parse(raw);
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new PreferencesApiFailure('invalid_response');
          const envelope = data as Record<string, unknown>;
          if (typeof envelope.traceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(envelope.traceId)) throw new PreferencesApiFailure('invalid_response');
          if (response.status === 401 || response.status === 403) throw new AuthFailure(response.status === 401 ? 'unauthorized' : 'forbidden', envelope.traceId);
          if (response.status === 409) throw new PreferencesApiFailure('conflict');
          if (!response.ok) throw new PreferencesApiFailure('unavailable');
          return parsePreferences(envelope.preferences);
        };
        return await Promise.race([load(), deadline]);
      } catch (error) {
        if (error instanceof AuthFailure || error instanceof PreferencesApiFailure) throw error;
        throw new PreferencesApiFailure('unavailable');
      } finally { clearTimeout(timer); controller.abort(); }
    });
  }
  return { read: () => call('GET'), save: (preferences: Matrix, expectedVersion: number, key: string) =>
    call('PUT', { preferences, expectedVersion }, key) };
}
