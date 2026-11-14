import { timingSafeEqual } from 'node:crypto';
import { apiVersions, assistanceSearchPath } from '@solventa/contracts';
import { gateApiVersion, withHeaders } from './api-versions';
import { isApiDocsPath, serveApiDocs } from './api-docs';
import { withSecurityHeaders } from './security-headers';
import { fetchService } from './service-fetch';

const quotesPath = /^\/api\/v1\/(?:(me\/)?quotes|quote-estimates)(\/|$)/;
const isQuotesPath = (path: string) => quotesPath.test(path);
const offersPath = /^\/api\/v1\/offers(\/|$)/;
const partnerOffersPath = /^\/api\/v1\/partner\/offers(\/|$)/;
const policiesPath = /^\/api\/v[12]\/policies(\/|$)/;
const claimsPath = /^\/api\/v1\/claims(\/|$)/;
const claimDraftsPath = /^\/api\/v1\/claim-drafts(\/|$)/;
const assistanceRequestsPath = /^\/api\/v1\/assistance\/requests(?:\/[^/]+)?$/;
const requirementEvidencePath = /^\/api\/v1\/claims\/[^/]+\/requirements\/[^/]+\/files\/[^/]+$/;
const claimEvidencePath = /^\/api\/v1\/claims\/[^/]+\/evidence\/[^/]+$/;
// One report holds at most 50 MiB of evidence; Policy enforces the exact size, type and checksum of each file.
const MAX_EVIDENCE_BYTES = 50 * 1024 * 1024;
const EVIDENCE_DEADLINE_MS = 120_000;

function unavailable(request: Request, headers: Record<string, string>, error: string): Response {
  const supplied = request.headers.get('x-trace-id') ?? '';
  const traceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(supplied)
    ? supplied.toLowerCase()
    : crypto.randomUUID();
  return Response.json({ error, traceId }, { status: 503, headers: { ...headers, 'x-trace-id': traceId } });
}

// Credentials travel untouched: Acquisition verifies them through Identity.
async function forwardToAcquisition(request: Request, env: WebEnv, headers: Record<string, string>): Promise<Response> {
  try { return await fetchService(request, env.ACQUISITION); }
  catch { return unavailable(request, headers, 'service_unavailable'); }
}

async function forwardToPolicy(request: Request, env: WebEnv, headers: Record<string, string>, error = 'financial_unavailable'): Promise<Response> {
  try { return await fetchService(request, env.POLICY); }
  catch { return unavailable(request, headers, error); }
}

// An evidence file streams to Policy without buffering it in the gateway, so a video never competes for Worker memory and a slow mobile link
// is not cut by the five-second budget of the small JSON routes. Policy still authenticates before reading a byte.
async function forwardEvidence(request: Request, env: WebEnv, headers: Record<string, string>): Promise<Response> {
  const length = request.headers.get('content-length');
  if (!length || !/^\d+$/.test(length) || Number(length) < 1 || Number(length) > MAX_EVIDENCE_BYTES) {
    await request.body?.cancel().catch(() => {});
    const supplied = request.headers.get('x-trace-id') ?? '';
    const traceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(supplied) ? supplied.toLowerCase() : crypto.randomUUID();
    return Response.json({ error: 'invalid_request', fields: ['body'], traceId }, { status: 400, headers: { ...headers, 'x-trace-id': traceId } });
  }
  try { return await env.POLICY.fetch(new Request(request, { signal: AbortSignal.timeout(EVIDENCE_DEADLINE_MS) })); }
  catch { return unavailable(request, headers, 'service_unavailable'); }
}

async function route(request: Request, env: WebEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    if (path === '/health') return Response.json({ status: 'alive', environment: env.APP_ENV }, { headers });
    if (isApiDocsPath(path)) return serveApiDocs(request, env);
    if (path.startsWith('/auth/')) return env.IDENTITY.fetch(request);
    if (path.startsWith('/api/')) {
      const gate = gateApiVersion(path, new Date(), apiVersions);
      if (gate.response) return gate.response;
      if (path === '/api/v1/access/partner' || path === '/api/v1/access/web' || path === '/api/v1/access/mobile' || /^\/api\/v1\/(consents|mobile|me\/partner-authorizations)(\/|$)/.test(path)) {
        try { return withHeaders(await fetchService(request, env.IDENTITY), gate.headers); }
        catch { return withHeaders(unavailable(request, headers, 'access_unavailable'), gate.headers); }
      }
      const response = /^\/api\/v[12]\/partner-portal$/.test(path) || isQuotesPath(path) || offersPath.test(path) || partnerOffersPath.test(path) || /^\/api\/v1\/underwriting-decisions(\/|$)/.test(path) ? await forwardToAcquisition(request, env, headers)
        : policiesPath.test(path) || /^\/api\/v1\/advisor-authorizations(\/|$)/.test(path) ? await forwardToPolicy(request, env, headers)
        : (claimEvidencePath.test(path) || requirementEvidencePath.test(path)) && request.method === 'PUT' ? await forwardEvidence(request, env, headers)
        : claimsPath.test(path) || claimDraftsPath.test(path) || path === assistanceSearchPath || assistanceRequestsPath.test(path) ? await forwardToPolicy(request, env, headers, 'service_unavailable')
        : Response.json({ error: 'not_implemented' }, { status: 404, headers });
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
}

export default {
  async fetch(request: Request, env: WebEnv): Promise<Response> {
    return withSecurityHeaders(request, await route(request, env));
  },
} satisfies ExportedHandler<WebEnv>;
