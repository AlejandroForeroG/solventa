import { parseClaimPaymentPage } from '@solventa/contracts';
import { validateBaseUrl } from '../../authentication/adapters/solventa-session';
import { AuthFailure } from '../../authentication/domain/session';
import type { ClaimPaymentsApi } from '../application/claim-payments';
import { ClaimPaymentFailure } from '../domain/payment';

type Owner = { clientId: string; subjectToken: string };
type Session = { execute<T>(work: (token: string) => Promise<T>, expectedOwner?: Owner): Promise<T> };
export function createClaimPaymentsApi(baseUrl: string, session: Session, owner: Owner, request: typeof fetch = fetch, claimId?: string): ClaimPaymentsApi {
  validateBaseUrl(baseUrl);
  return { list: async (cursor, signal) => { try { return await session.execute(async token => {
    const controller = new AbortController();
    const cancel = () => controller.abort(); signal.addEventListener('abort', cancel, { once: true });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => {
      controller.abort(); void reader?.cancel().catch(() => {}); reject(new ClaimPaymentFailure('unavailable'));
    }, 8000); });
    try {
      if (signal.aborted) throw new ClaimPaymentFailure('unavailable');
      const query = claimId ? '?claimId=' + encodeURIComponent(claimId) : cursor ? '?cursor=' + encodeURIComponent(cursor) : '';
      const response = await Promise.race([request(baseUrl + '/api/v1/claims/native/disbursements' + query, {
        method: 'GET', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + token } }), deadline]);
      if (response.status === 401) throw new AuthFailure('unauthorized');
      if (response.status === 403) throw new ClaimPaymentFailure('forbidden');
      if (!response.ok) throw new ClaimPaymentFailure(response.status >= 500 || response.status === 429 ? 'unavailable' : 'invalid_response');
      const parse = async () => {
        if (!response.headers.get('content-type')?.includes('application/json')) throw new ClaimPaymentFailure('invalid_response');
        let text = '';
        if (response.body?.getReader) {
          reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes = 0;
          for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength;
            if (bytes > 64 * 1024) throw new ClaimPaymentFailure('invalid_response'); text += decoder.decode(chunk.value, { stream: true }); }
          text += decoder.decode();
        } else { text = await response.text(); if (text.length > 64 * 1024) throw new ClaimPaymentFailure('invalid_response'); }
        let value: unknown;
        try { value = JSON.parse(text); } catch { throw new ClaimPaymentFailure('invalid_response'); }
        const page = parseClaimPaymentPage(value);
        if (!page || (claimId && (page.next || page.items.some(item => item.claimId !== claimId)))) throw new ClaimPaymentFailure('invalid_response');
        return page;
      };
      return await Promise.race([parse(), deadline]);
    } catch (error) {
      if (error instanceof AuthFailure || error instanceof ClaimPaymentFailure) throw error;
      throw new ClaimPaymentFailure('unavailable');
    } finally { clearTimeout(timeout); controller.abort(); void reader?.cancel().catch(() => {}); signal.removeEventListener('abort', cancel); }
  }, owner); } catch (error) {
    if (error instanceof AuthFailure) throw new ClaimPaymentFailure(error.kind === 'unauthorized' ? 'unauthorized' : 'unavailable');
    throw error;
  } } };
}
