import { AuthFailure } from '../../authentication/domain/session';
import { validateBaseUrl } from '../../authentication/adapters/solventa-session';
import type { AuthenticatedSession } from '../../policy-wallet/application/ports';
import type { NoticesApi } from '../application/ports';
import { NoticeFailure, object, parseNotices, parseReceipt, uuid } from '../domain/notice';
import { parseDestination, type NoticeDestination } from '../domain/destination';

const MAX_BYTES = 65_536;

export function createNoticesApi(baseUrl: string, session: AuthenticatedSession, request: typeof fetch = fetch): NoticesApi & { destination(eventId: string): Promise<NoticeDestination> } {
  validateBaseUrl(baseUrl);
  const call = (path: string, body?: { outcome: string }): Promise<unknown> => session.execute(async token => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await request(`${baseUrl}/api/v2/notices${path}`, {
        method: body ? 'POST' : 'GET', credentials: 'omit', signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 401) throw new AuthFailure('unauthorized');
      if (response.status === 403) throw new AuthFailure('forbidden');
      if (response.status >= 500 || response.status === 429) throw new NoticeFailure('unavailable');
      if (!response.headers.get('content-type')?.includes('application/json') || Number(response.headers.get('content-length')) > MAX_BYTES) throw new NoticeFailure('invalid_response');
      const text = await response.text();
      if (new TextEncoder().encode(text).length > MAX_BYTES) throw new NoticeFailure('invalid_response');
      const data: unknown = JSON.parse(text);
      if (!object(data) || !uuid(data.traceId)) throw new NoticeFailure('invalid_response');
      if (!response.ok) {
        const codes: Record<number, readonly string[]> = { 400: ['invalid_request'], 404: ['not_found'], 409: ['conflict'], 415: ['unsupported_media_type'] };
        if (typeof data.error !== 'string' || !codes[response.status]?.includes(data.error)) throw new NoticeFailure('invalid_response');
        throw new NoticeFailure('rejected');
      }
      return data;
    } catch (error) {
      if (error instanceof AuthFailure || error instanceof NoticeFailure) throw error;
      throw new NoticeFailure(error instanceof SyntaxError ? 'invalid_response' : 'unavailable');
    } finally { clearTimeout(timer); }
  });
  return {
    async destination(eventId) {
      if (!uuid(eventId)) throw new NoticeFailure('rejected');
      return parseDestination(await call(`/${eventId}/destination`));
    },
    list: async () => parseNotices(await call('')),
    async receipt(eventId, outcome) {
      if (!uuid(eventId)) throw new NoticeFailure('rejected');
      parseReceipt(await call(`/${eventId}/receipt`, { outcome }), eventId, outcome);
    },
  };
}
