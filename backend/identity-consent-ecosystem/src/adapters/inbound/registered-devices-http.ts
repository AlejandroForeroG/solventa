import type { Hono } from 'hono';
import type { RegisteredDevices } from '../../application/registered-devices';
import type { MobileAuthenticationDependencies } from './mobile-authentication-http';
import type { SecurityDecisions } from '../../application/security-decisions';

export function mountRegisteredDevices(app: Hono<{ Bindings: IdentityEnv }>, mobile: MobileAuthenticationDependencies | null, devices?: RegisteredDevices, security?: Pick<SecurityDecisions, 'deny'>) {
  app.all('/api/v1/mobile/devices/:installationId', async c => {
    const supplied = c.req.header('X-Trace-Id') ?? '';
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const traceId = uuid.test(supplied) ? supplied.toLowerCase() : crypto.randomUUID();
    c.header('X-Trace-Id', traceId);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    const fail = async (error: string, status: 400 | 401 | 405 | 503, record = true) => {
      if (status === 401) {
        try { if (record) await security?.deny({ category: 'api_access', channel: 'mobile', operation: 'mobile:devices', cause: 'unauthorized' }, traceId); }
        catch { return c.json({ error: 'access_unavailable', traceId }, 503); }
        c.header('WWW-Authenticate', 'Bearer realm="solventa"');
      }
      return c.json({ error, traceId }, status);
    };
    const action = c.req.method === 'POST' ? 'register' : c.req.method === 'GET' ? 'find' : c.req.method === 'DELETE' ? 'revoke' : null;
    if (!action) { c.header('Allow', 'GET, POST, DELETE'); return fail('method_not_allowed', 405); }
    const installationId = c.req.param('installationId');
    if (installationId.length !== 36 || !uuid.test(installationId) || installationId[14] !== '4' || c.req.header('Cookie')) return fail('invalid_request', 400);
    if (!mobile || !devices) return fail('access_unavailable', 503);
    const token = c.req.header('Authorization')?.match(/^Bearer ([A-Za-z0-9_.-]+)$/i)?.[1] ?? '';
    if (!token || token.length > 8192) return fail('unauthorized', 401);
    try {
      const identity = await mobile.provider.authenticate(token);
      if (!identity) return fail('unauthorized', 401);
      const device = await devices.execute(action, { identity, installationId, correlationId: traceId });
      if (!device) return fail('unauthorized', 401, false);
      if (action === 'revoke') await mobile.provider.revoke(identity);
      return c.json({ device, traceId });
    } catch { return fail('access_unavailable', 503); }
  });
}
