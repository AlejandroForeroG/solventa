import { timingSafeEqual } from 'node:crypto';
import { apiVersions } from '@solventa/contracts';
import { gateApiVersion, withHeaders } from './api-versions';

const quotesPath = /^\/api\/v1\/(me\/)?quotes(\/|$)/;
const isQuotesPath = (path: string) => quotesPath.test(path);

function unavailable(headers: Record<string, string>, error: string): Response {
  const traceId = crypto.randomUUID();
  return Response.json({ error, traceId }, { status: 503, headers: { ...headers, 'x-trace-id': traceId } });
}

// Credentials travel untouched: Acquisition verifies them through Identity.
async function forwardToAcquisition(request: Request, env: WebEnv, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try { return await env.ACQUISITION.fetch(new Request(request, { signal: controller.signal })); }
  catch { return unavailable(headers, 'service_unavailable'); }
  finally { clearTimeout(timeout); }
}

export default {
  async fetch(request: Request, env: WebEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    if (path === '/health') return Response.json({ status: 'alive', environment: env.APP_ENV }, { headers });
    if (path.startsWith('/auth/')) return env.IDENTITY.fetch(request);
    if (path.startsWith('/api/')) {
      const gate = gateApiVersion(path, new Date(), apiVersions);
      if (gate.response) return gate.response;
      if (path === '/api/v1/access/partner' || path === '/api/v1/access/web') {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try { return withHeaders(await env.IDENTITY.fetch(new Request(request, { signal: controller.signal })), gate.headers); }
        catch {
          const requestedTrace = request.headers.get('X-Trace-Id') ?? '';
          const traceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedTrace) ? requestedTrace : crypto.randomUUID();
          return withHeaders(Response.json({ error: 'access_unavailable', traceId }, { status: 503, headers: { ...headers, 'x-trace-id': traceId } }), gate.headers);
        } finally { clearTimeout(timeout); }
      }
      const response = isQuotesPath(path) ? await forwardToAcquisition(request, env, headers) : Response.json({ error: 'not_implemented' }, { status: 404, headers });
      return withHeaders(response, gate.headers);
    }
    if (path.startsWith('/internal/')) {
      const token = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      const expected = env.DEV_INFRA_TOKEN;
      if (!expected || !token) return Response.json({ error: 'unauthorized' }, { status: 401, headers });
      const encoder = new TextEncoder();
      const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(token)), crypto.subtle.digest('SHA-256', encoder.encode(expected))]);
      if (!timingSafeEqual(new Uint8Array(a), new Uint8Array(b))) return Response.json({ error: 'unauthorized' }, { status: 401, headers });
      if (path !== '/internal/infra' || request.method !== 'GET') return Response.json({ error: 'not_found' }, { status: 404, headers });
      try {
        const services = await Promise.all([env.ACQUISITION.infraStatus(), env.IDENTITY.infraStatus(), env.POLICY.infraStatus()]);
        const ready = services.every(s => s.ready && s.environment === env.APP_ENV && s.databaseName === `solventa_${env.APP_ENV}`);
        return Response.json({ environment: env.APP_ENV, ready, services }, { status: ready ? 200 : 503, headers });
      } catch { return Response.json({ ready: false }, { status: 503, headers }); }
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<WebEnv>;
