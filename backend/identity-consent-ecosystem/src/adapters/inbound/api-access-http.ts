import type { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { isApiOperation } from '../../application/api-access';
import type { AccessDecision, ApiOperation, ApiAccess, PartnerIdentity } from '../../application/api-access';
import type { VerifiedIdentity } from '../../application/authentication';

export type ApiAccessDependencies = {
  application: Pick<ApiAccess, 'partner' | 'webUser'>;
  mobile?: { authenticate(token: string): Promise<VerifiedIdentity | null>; authorize(identity: VerifiedIdentity, operation: string): Promise<AccessDecision> } | null;
  partner: { authenticate(token: string): Promise<PartnerIdentity | null> } | null;
  web: {
    authenticate(cookie: string, refresh: boolean): Promise<{ identity: VerifiedIdentity } | null>;
    allowedOrigins: readonly string[];
  } | null;
};
export type AuthorizeApiAccess = (input: unknown) => Promise<AccessDecision>;

export type ApiAccessRequest =
  | { kind: 'partner'; token: string; operation: ApiOperation }
  | { kind: 'mobile'; token: string; operation: ApiOperation }
  | { kind: 'web'; cookie: string; origin: string; method: string; operation: ApiOperation };

function isAccessRequest(value: unknown): value is ApiAccessRequest {
  if (!value || typeof value !== 'object') return false;
  if (!('operation' in value) || !isApiOperation(value.operation) || !('kind' in value)) return false;
  if (value.kind === 'partner' || value.kind === 'mobile') return 'token' in value && typeof value.token === 'string' && value.token.length <= 8192;
  return value.kind === 'web' && 'cookie' in value && typeof value.cookie === 'string' && value.cookie.length <= 16384
    && 'origin' in value && typeof value.origin === 'string' && value.origin.length <= 256
    && 'method' in value && typeof value.method === 'string' && ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(value.method);
}

// Shared by HTTP probes and the private RPC. Actor identity comes only from verified credentials, never from caller IDs.
export async function authorizeApiAccess(deps: ApiAccessDependencies, input: unknown): Promise<AccessDecision> {
  if (!isAccessRequest(input)) return { allowed: false, error: 'invalid_request', status: 400 };
  const unauthorized = { allowed: false, error: 'unauthorized', status: 401 } as const;
  try {
    const { application } = deps;
    if (input.kind === 'mobile') {
      if (!input.token) return unauthorized;
      if (!deps.mobile) return { allowed: false, error: 'access_unavailable', status: 503 };
      const identity = await deps.mobile.authenticate(input.token);
      return identity ? await deps.mobile.authorize(identity, input.operation) : unauthorized;
    }
    if (input.kind === 'partner') {
      if (!input.token) return unauthorized;
      if (!deps.partner) return { allowed: false, error: 'access_unavailable', status: 503 };
      const identity = await deps.partner.authenticate(input.token);
      return identity ? await application.partner(identity, input.operation) : unauthorized;
    }
    if (!deps.web) return { allowed: false, error: 'access_unavailable', status: 503 };
    if (!['GET', 'HEAD'].includes(input.method) && !deps.web.allowedOrigins.includes(input.origin)) return { allowed: false, error: 'forbidden', status: 403 };
    if (!input.cookie) return unauthorized;
    // Refresh remains in /auth/session so a business RPC never loses a rotated cookie.
    const verified = await deps.web.authenticate(input.cookie, false);
    return verified ? await application.webUser(verified.identity, input.operation) : unauthorized;
  } catch {
    return { allowed: false, error: 'access_unavailable', status: 503 };
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function mountApiAccess(app: Hono<{ Bindings: IdentityEnv }>, authorize: AuthorizeApiAccess) {
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
      const decision = await authorize(request);
      if (!decision.allowed) {
        if (decision.status === 401 && kind === 'partner') c.header('WWW-Authenticate', 'Bearer realm="solventa"');
        return c.json({ error: decision.error, traceId }, decision.status);
      }
      return c.json({ actor: decision.actor, traceId });
    });
  }
}
