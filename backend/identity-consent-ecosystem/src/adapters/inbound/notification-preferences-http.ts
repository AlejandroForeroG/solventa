import type { Hono } from 'hono';
import type { ApiOperation, AccessDecision } from '../../application/api-access';
import type { VerifiedIdentity } from '../../application/authentication';
import type { NotificationPreferences } from '../../application/notification-preferences';
import type { SecurityDecisions } from '../../application/security-decisions';
import { canonicalNotificationRequest, notificationMatrix, NotificationPreferenceFailure } from '../../domain/notification-preferences';
import type { MobileAuthenticationDependencies } from './mobile-authentication-http';

const base = '/api/v1/mobile/notification-preferences';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

async function bodyOf(request: Request): Promise<unknown> {
  if (!request.body) throw new NotificationPreferenceFailure('invalid_request', 400);
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async () => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 4096) throw new NotificationPreferenceFailure('invalid_request', 400);
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
    };
    return await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new NotificationPreferenceFailure('invalid_request', 400)), 5000);
    })]);
  } catch (error) {
    if (error instanceof NotificationPreferenceFailure) throw error;
    throw new NotificationPreferenceFailure('invalid_request', 400);
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function mountNotificationPreferences(app: Hono<{ Bindings: IdentityEnv }>, deps: {
  mobile: MobileAuthenticationDependencies | null; application?: NotificationPreferences;
  authorize?: (identity: VerifiedIdentity, operation: ApiOperation) => Promise<AccessDecision>;
  security?: Pick<SecurityDecisions, 'deny'>;
}) {
  app.all(base, async c => {
    const supplied = c.req.header('X-Trace-Id') ?? '';
    const traceId = uuid.test(supplied) ? supplied.toLowerCase() : crypto.randomUUID();
    c.header('X-Trace-Id', traceId);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    const operation = c.req.method === 'GET' ? 'notification-preferences:read' : 'notification-preferences:write';
    const respond = (body: object, status: 200 | 400 | 401 | 403 | 405 | 409 | 503) => {
      if (status === 401) c.header('WWW-Authenticate', 'Bearer realm="solventa"');
      return c.json({ ...body, traceId }, status);
    };
    const deny = async (cause: 'unauthorized' | 'forbidden') => {
      if (!deps.security) throw new Error('security_recording_unavailable');
      await deps.security.deny({ category: 'api_access', channel: 'mobile', operation, cause }, traceId);
    };
    try {
      if (c.req.method !== 'GET' && c.req.method !== 'PUT') { c.header('Allow', 'GET, PUT'); return respond({ error: 'method_not_allowed' }, 405); }
      if (c.req.header('Cookie') !== undefined || new URL(c.req.url).search) return respond({ error: 'invalid_request' }, 400);
      if (!deps.mobile || !deps.application || !deps.authorize) return respond({ error: 'access_unavailable' }, 503);
      const token = c.req.header('Authorization')?.match(/^Bearer ([A-Za-z0-9_.-]+)$/i)?.[1];
      if (!token || token.length > 8192) { await deny('unauthorized'); return respond({ error: 'unauthorized' }, 401); }
      const identity = await deps.mobile.provider.authenticate(token);
      if (!identity) { await deny('unauthorized'); return respond({ error: 'unauthorized' }, 401); }
      const access = await deps.authorize(identity, operation);
      if (!access.allowed) {
        if (access.status === 401 || access.status === 403) await deny(access.status === 401 ? 'unauthorized' : 'forbidden');
        return respond({ error: access.error }, access.status);
      }
      if (access.actor.kind !== 'user' || access.actor.channel !== 'mobile' || !access.actor.operations.includes(operation)) {
        await deny('forbidden'); return respond({ error: 'forbidden' }, 403);
      }
      const clientId = access.actor.principal.clientId;
      if (c.req.method === 'GET') return respond({ preferences: await deps.application.read(clientId, identity) }, 200);
      const key = c.req.header('Idempotency-Key') ?? '';
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key) || !c.req.header('Content-Type')?.match(/^application\/json(?:\s*;.*)?$/i))
        return respond({ error: 'invalid_request' }, 400);
      const declared = c.req.header('Content-Length');
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > 4096)) return respond({ error: 'invalid_request' }, 400);
      const body = await bodyOf(c.req.raw);
      if (!object(body) || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'expectedVersion') || !Object.hasOwn(body, 'preferences')
        || !notificationMatrix(body.preferences) || typeof body.expectedVersion !== 'number' || !Number.isSafeInteger(body.expectedVersion))
        return respond({ error: 'invalid_request' }, 400);
      const bytes = new TextEncoder().encode(canonicalNotificationRequest(body.expectedVersion, body.preferences));
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const requestHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      return respond({ preferences: await deps.application.save({ clientId, actor: access.actor.principal.subjectToken,
        preferences: body.preferences, expectedVersion: body.expectedVersion, key, traceId, requestHash, identity }) }, 200);
    } catch (error) {
      if (error instanceof NotificationPreferenceFailure) {
        if (error.status === 401) { try { await deny('unauthorized'); } catch { return respond({ error: 'access_unavailable' }, 503); } }
        return respond({ error: error.code }, error.status);
      }
      if (error instanceof SyntaxError) return respond({ error: 'invalid_request' }, 400);
      return respond({ error: 'access_unavailable' }, 503);
    } finally { if (c.req.raw.body && !c.req.raw.bodyUsed) await c.req.raw.body.cancel().catch(() => {}); }
  });
}
