import type { Hono } from 'hono';
import type { VerifiedIdentity } from '../../application/authentication';
import type { MobileSessions } from '../../application/mobile-sessions';
import type { AuthorizeApiAccess } from './api-access-http';

export type MobileAuthenticationDependencies = {
  configuration: { clientId: string; redirectUri: string };
  provider: { authenticate(token: string): Promise<VerifiedIdentity | null>; revoke(identity: VerifiedIdentity): Promise<void> };
  sessions: MobileSessions;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function mountMobileAuthentication(app: Hono<{ Bindings: IdentityEnv }>, dependencies: MobileAuthenticationDependencies | null, authorize: AuthorizeApiAccess) {
  for (const path of ['/api/v1/mobile/config', '/api/v1/mobile/session', '/api/v1/access/mobile']) {
    app.all(path, async c => {
      const supplied = c.req.header('X-Trace-Id') ?? '';
      const traceId = uuid.test(supplied) ? supplied : crypto.randomUUID();
      c.header('X-Trace-Id', traceId);
      c.header('Cache-Control', 'no-store');
      c.header('X-Content-Type-Options', 'nosniff');
      const fail = (error: string, status: 400 | 401 | 405 | 503) => {
        if (status === 401) c.header('WWW-Authenticate', 'Bearer realm="solventa"');
        return c.json({ error, traceId }, status);
      };
      const methods = path.endsWith('/session') ? ['GET', 'POST', 'DELETE'] : ['GET'];
      if (!methods.includes(c.req.method)) {
        c.header('Allow', methods.join(', '));
        return fail('method_not_allowed', 405);
      }
      if (!dependencies) return fail('access_unavailable', 503);
      if (path.endsWith('/config')) return c.json({
        clientId: dependencies.configuration.clientId,
        redirectUri: dependencies.configuration.redirectUri,
        authorizationEndpoint: 'https://api.workos.com/user_management/authorize',
        tokenEndpoint: 'https://api.workos.com/user_management/authenticate',
        traceId,
      });
      // Native bearer credentials never fall back to a web session cookie.
      if (c.req.header('Cookie')) return fail('invalid_request', 400);
      const token = c.req.header('Authorization')?.match(/^Bearer ([A-Za-z0-9_.-]+)$/i)?.[1] ?? '';
      if (!token || token.length > 8192) return fail('unauthorized', 401);
      try {
        if (path.endsWith('/mobile')) {
          const decision = await authorize({ kind: 'mobile', token, operation: 'quotes:create' });
          if (!decision.allowed) {
            if (decision.status === 401) c.header('WWW-Authenticate', 'Bearer realm="solventa"');
            return c.json({ error: decision.error, traceId }, decision.status);
          }
          return c.json({ actor: decision.actor, traceId });
        }
        const identity = await dependencies.provider.authenticate(token);
        if (!identity) return fail('unauthorized', 401);
        if (c.req.method === 'DELETE') {
          // Local revocation is durable even if provider revocation needs a retry.
          await dependencies.sessions.revoke(identity);
          await dependencies.provider.revoke(identity);
          return c.json({ status: 'signed_out', traceId });
        }
        const principal = c.req.method === 'POST'
          ? await dependencies.sessions.register(identity) : await dependencies.sessions.find(identity);
        if (!principal) return fail('unauthorized', 401);
        return c.json({ principal, channel: 'mobile', traceId });
      } catch { return fail('access_unavailable', 503); }
    });
  }
}
