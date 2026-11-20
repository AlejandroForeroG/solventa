import { isClaimCaseId, parseCustomerClaimCase, parseOwnedClaimList } from '@solventa/contracts';
import { validateBaseUrl } from '../../authentication/adapters/solventa-session';
import { AuthFailure } from '../../authentication/domain/session';

type Owner = { clientId: string; subjectToken: string };
type Session = { execute<T>(work: (token: string) => Promise<T>, expectedOwner?: Owner): Promise<T> };
type Failure = 'unauthorized' | 'forbidden' | 'not_found' | 'unavailable';
type Result<T> = { kind: 'ok'; value: T } | { kind: Failure };

export function createClaimTrackingApi(baseUrl: string, session: Session, owner: Owner, request: typeof fetch = fetch) {
  validateBaseUrl(baseUrl);
  async function read<T>(path: string, parse: (body: unknown) => T | null, signal: AbortSignal): Promise<Result<T>> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal.aborted) return { kind: 'unavailable' };
    signal.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(cancel, 8000);
    try {
      return await session.execute(async token => {
        if (controller.signal.aborted) return { kind: 'unavailable' };
        const response = await request(baseUrl + '/api/v1/claims/native/cases' + path, {
          method: 'GET', signal: controller.signal, credentials: 'omit', cache: 'no-store',
          headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
        });
        if (response.status === 401) throw new AuthFailure('unauthorized');
        if (response.status === 403) return { kind: 'forbidden' };
        if (response.status === 404) return { kind: 'not_found' };
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return { kind: 'unavailable' };
        const value = parse(await response.json());
        return value !== null && !controller.signal.aborted ? { kind: 'ok', value } : { kind: 'unavailable' };
      }, owner);
    } catch (error) {
      return { kind: error instanceof AuthFailure && error.kind === 'unauthorized' ? 'unauthorized' : 'unavailable' };
    } finally {
      clearTimeout(timeout);
      controller.abort();
      signal.removeEventListener('abort', cancel);
    }
  }

  return {
    list: (signal: AbortSignal) => read('', parseOwnedClaimList, signal),
    detail: (claimId: string, signal: AbortSignal) => isClaimCaseId(claimId)
      ? read('/' + claimId.toLowerCase(), parseCustomerClaimCase, signal) : Promise.resolve({ kind: 'not_found' } as const),
  };
}
