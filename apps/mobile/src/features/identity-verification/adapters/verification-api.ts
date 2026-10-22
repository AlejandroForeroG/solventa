import { AuthFailure } from '../../authentication/domain/session';
import { validateBaseUrl } from '../../authentication/adapters/solventa-session';
import type { AuthenticatedSession, VerificationApi, VerificationCommand } from '../application/ports';
import { VerificationApiFailure } from '../domain/verification';
import { fixtures, invalid, object, terms, trace, verification } from './verification-validation';

export function createVerificationApi(baseUrl: string, session: AuthenticatedSession, request: typeof fetch = fetch): VerificationApi {
  validateBaseUrl(baseUrl);
  async function call(path: string, method = 'GET', body?: unknown, key?: string) {
    return session.execute(async token => {
      const controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => { controller.abort(); void reader?.cancel().catch(() => {}); reject(new VerificationApiFailure('unavailable', true)); }, 12_000);
      });
      try {
        const response = await Promise.race([request(`${baseUrl}/api/v1/mobile/identity-verifications${path}`, {
          method, credentials: 'omit', signal: controller.signal,
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
        }), deadline]);
        // React Native fetch does not consistently expose a streaming body. Both paths share the same abort deadline.
        const parse = async () => {
          if (!response.headers.get('content-type')?.includes('application/json')) invalid();
          let raw: string;
          if (response.body?.getReader) {
            reader = response.body.getReader(); const decoder = new TextDecoder(); let total = 0; raw = '';
            for (;;) { const chunk = await reader.read(); if (chunk.done) break; total += chunk.value.byteLength; if (total > 64 * 1024) invalid(); raw += decoder.decode(chunk.value, { stream: true }); }
            raw += decoder.decode();
          } else { raw = await response.text(); if (raw.length > 64 * 1024) invalid(); }
          const data = object(JSON.parse(raw)); const traceId = trace(data.traceId); if (!traceId) invalid();
          if (response.status === 401) throw new AuthFailure('unauthorized', traceId);
          if (!response.ok) {
            const saved = data.verification === undefined ? undefined : verification(data.verification);
            const code = typeof data.error === 'string' && /^[a-z_]{1,60}$/.test(data.error) ? data.error : 'invalid_response';
            throw new VerificationApiFailure(code, response.status >= 500 && !saved, traceId, saved);
          }
          return data;
        };
        // The timer must also bound a stalled response body, including a non-streaming native response.
        return await Promise.race([parse(), deadline]);
      } catch (error) {
        if (error instanceof AuthFailure || error instanceof VerificationApiFailure) throw error;
        throw new VerificationApiFailure('unavailable', true);
      } finally { if (timeout) clearTimeout(timeout); controller.abort(); void reader?.cancel().catch(() => {}); }
    });
  }
  return {
    async current() { const data = await call(''); return data.verification === null ? null : verification(data.verification); },
    async terms(locale) { const value = terms((await call(`/terms?locale=${locale}`)).terms); if (value.locale !== locale) invalid(); return value; },
    async fixtures() { return fixtures((await call('/fixtures')).fixtures); },
    async execute(command: VerificationCommand, key: string) {
      const path = command.action === 'grant' ? '' : command.action === 'step' ? `/${command.id}/steps/${command.step}` : `/${command.id}/${command.action}`;
      return verification((await call(path, command.action === 'step' ? 'PUT' : 'POST', command.body, key)).verification);
    },
  };
}
