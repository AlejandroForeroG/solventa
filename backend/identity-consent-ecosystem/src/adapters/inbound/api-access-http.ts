import type { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { ApiAccess, isApiOperation } from '../../application/api-access';
import type { AccessDecision, ApiOperation } from '../../application/api-access';
import { SqlIdentitySessions } from '../outbound/identity-sessions';
import { SqlPartnerAccess } from '../outbound/partner-access';
import { WorkosAuthentication } from '../outbound/workos-authentication';
import { WorkosPartnerAuthentication } from '../outbound/workos-partner-authentication';
import { configuration } from './authentication-http';

export type ApiAccessRequest =
  | { kind: 'partner'; token: string; operation: ApiOperation }
  | { kind: 'web'; cookie: string; origin: string; method: string; operation: ApiOperation };

function isAccessRequest(value: unknown): value is ApiAccessRequest {
  if (!value || typeof value !== 'object') return false;
  if (!('operation' in value) || !isApiOperation(value.operation) || !('kind' in value)) return false;
  if (value.kind === 'partner') return 'token' in value && typeof value.token === 'string' && value.token.length <= 8192;
  return value.kind === 'web' && 'cookie' in value && typeof value.cookie === 'string' && value.cookie.length <= 16384
    && 'origin' in value && typeof value.origin === 'string' && value.origin.length <= 256
    && 'method' in value && typeof value.method === 'string' && ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(value.method);
}

// Shared by HTTP probes and the private RPC. Actor identity comes only from verified credentials, never from caller IDs.
export async function authorizeApiAccess(env: IdentityEnv, input: unknown): Promise<AccessDecision> {
  if (!isAccessRequest(input)) return { allowed: false, error: 'invalid_request', status: 400 };
  const unauthorized = { allowed: false, error: 'unauthorized', status: 401 } as const;
  try {
    const application = new ApiAccess(new SqlPartnerAccess(env.IDENTITY_DB.connectionString), new SqlIdentitySessions(env.IDENTITY_DB.connectionString));
    if (input.kind === 'partner') {
      if (!input.token) return unauthorized;
      if (!env.WORKOS_CONNECT_ISSUER || !env.WORKOS_CONNECT_AUDIENCE) return { allowed: false, error: 'access_unavailable', status: 503 };
      const provider = new WorkosPartnerAuthentication({ issuer: env.WORKOS_CONNECT_ISSUER, audience: env.WORKOS_CONNECT_AUDIENCE });
      const identity = await provider.authenticate(input.token);
      return identity ? await application.partner(identity, input.operation) : unauthorized;
    }
    const config = configuration(env);
    if (!config) return { allowed: false, error: 'access_unavailable', status: 503 };
    const origins = config.local ? [config.origin, 'http://localhost:5173'] : [config.origin];
    if (!['GET', 'HEAD'].includes(input.method) && !origins.includes(input.origin)) return { allowed: false, error: 'forbidden', status: 403 };
    if (!input.cookie) return unauthorized;
    // Refresh remains in /auth/session so a business RPC never loses a rotated cookie.
    const verified = await new WorkosAuthentication(config).authenticate(input.cookie, false);
    return verified ? await application.webUser(verified.identity, input.operation) : unauthorized;
  } catch {
    return { allowed: false, error: 'access_unavailable', status: 503 };
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function mountApiAccess(app: Hono<{ Bindings: IdentityEnv }>, authorize = authorizeApiAccess) {
  for (const kind of ['partner', 'web'] as const) {
    app.all(`/api/v1/access/${kind}`, async c => {
      const requestedTrace = c.req.header('X-Trace-Id') ?? '';
      const traceId = uuid.test(requestedTrace) ? requestedTrace : crypto.randomUUID();
      c.header('X-Trace-Id', traceId);
      c.header('Cache-Control', 'no-store');
      c.header('X-Content-Type-Options', 'nosniff');
      if (c.req.method !== 'GET') {
        c.header('Allow', 'GET');
        return c.json({ error: 'method_not_allowed', traceId }, 405);
      }
      const authHeader = c.req.header('Authorization');
      if (kind === 'web' && authHeader !== undefined) return c.json({ error: 'invalid_request', traceId }, 400);
      const token = authHeader?.match(/^Bearer ([A-Za-z0-9_.-]+)$/i)?.[1] ?? '';
      const request: ApiAccessRequest = kind === 'partner'
        ? { kind, token, operation: 'quotes:create' }
        : { kind, cookie: getCookie(c, (c.env.APP_ENV === 'local' ? '' : '__Host-') + 'solventa-session') ?? '', origin: c.req.header('Origin') ?? '', method: c.req.method, operation: 'quotes:create' };
      const decision = await authorize(c.env, request);
      if (!decision.allowed) {
        if (decision.status === 401 && kind === 'partner') c.header('WWW-Authenticate', 'Bearer realm="solventa"');
        return c.json({ error: decision.error, traceId }, decision.status);
      }
      return c.json({ actor: decision.actor, traceId });
    });
  }
}
