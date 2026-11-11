import type { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { PortalQuery, PartnerPortal } from '../../application/partner-portal';

export type PortalHttpDependencies = { portal: Pick<PartnerPortal, 'read'>; authorize(input: { kind: 'web'; operation: 'partner-portal:read'; traceId: string; method: 'GET'; requestOrigin: string; origin: string; cookie: string }): Promise<unknown>; versions: readonly { id: string; deprecatedAt?: string; sunset?: string }[] };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const instant = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
function portalGrant(v: unknown) {
  if (!record(v) || !uuid(v.partnerId) || typeof v.code !== 'string' || !v.code.length || v.code.length > 128 || !instant(v.expiresAt)
    || typeof v.hasMoreCredentials !== 'boolean' || !Array.isArray(v.credentials) || v.credentials.length > 20) return null;
  const credentials = [];
  for (const c of v.credentials) {
    if (!record(c) || !uuid(c.id) || !instant(c.expiresAt) || !(typeof c.status === 'string' && ['active','expired','revoked'].includes(c.status))
      || !Array.isArray(c.scopes) || c.scopes.length > 32 || c.scopes.some(s => typeof s !== 'string' || !/^[a-z-]+:[a-z-]+$/.test(s))) return null;
    credentials.push({ id: c.id, scopes: c.scopes, expiresAt: c.expiresAt, status: c.status });
  }
  return { quota: v.quota, partnerId: v.partnerId, code: v.code, expiresAt: v.expiresAt, credentials, hasMoreCredentials: v.hasMoreCredentials };
}
export function portalQuery(params: URLSearchParams): PortalQuery | null {
  if (params.size !== 2 || params.getAll('from').length !== 1 || params.getAll('to').length !== 1) return null;
  const from = params.get('from') ?? '', to = params.get('to') ?? '';
  const date = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number(v.slice(0, 4)) >= 2000 && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  return date(from) && date(to) && days >= 0 && days < 31 ? { from, to } : null;
}

export function mountPartnerPortal(app: Hono<{ Bindings: AcquisitionEnv }>, deps: PortalHttpDependencies) {
  for (const path of ['/api/v1/partner-portal','/api/v2/partner-portal']) app.all(path, async c => {
    const supplied = c.req.header('x-trace-id');
    const traceId = uuid(supplied) ? supplied.toLowerCase() : crypto.randomUUID();
    const reply = (body: object, status: 200 | 400 | 401 | 403 | 405 | 503) => c.json({ ...body, traceId }, status,
      { 'cache-control': 'no-store', 'x-trace-id': traceId, 'x-content-type-options': 'nosniff' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (c.req.method !== 'GET') { c.header('Allow', 'GET'); return reply({ error: 'method_not_allowed' }, 405); }
      if (c.req.header('authorization') !== undefined) return reply({ error: 'invalid_request' }, 400);
      const access = await Promise.race([deps.authorize({ kind: 'web', operation: 'partner-portal:read', traceId, method: 'GET',
        requestOrigin: new URL(c.req.url).origin, origin: c.req.header('origin') ?? '', cookie: getCookie(c, (c.env.APP_ENV === 'local' ? '' : '__Host-') + 'solventa-session') ?? '' }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('access_deadline')), 2000); })]);
      clearTimeout(timer);
      if (!record(access)) return reply({ error: 'access_unavailable' }, 503);
      if (access.allowed !== true) {
        if ((access.status === 401 && access.error === 'unauthorized') || (access.status === 403 && access.error === 'forbidden')) return reply({ error: access.error }, access.status);
        return reply({ error: 'access_unavailable' }, 503);
      }
      const a = access.actor;
      const grant = record(a) ? portalGrant(a.partnerPortal) : null;
      if (!record(a) || a.kind !== 'user' || a.channel !== 'web' || !record(a.principal) || !uuid(a.principal.clientId) || !uuid(a.principal.subjectToken)
        || !Array.isArray(a.operations) || !a.operations.includes('partner-portal:read') || !grant || a.authorizationExpiresAt !== grant.expiresAt
        || !(Date.parse(grant.expiresAt) > Date.now()) || Date.parse(grant.expiresAt) > Date.now() + 5500) return reply({ error: 'access_unavailable' }, 503);
      const modern = new URL(c.req.url).pathname === '/api/v2/partner-portal';
      const quota = validQuota(grant.quota) ? grant.quota : null;
      if (modern ? !quota : grant.quota !== undefined) return reply({ error: 'portal_unavailable' }, 503);
      const query = portalQuery(new URL(c.req.url).searchParams);
      if (!query) return reply({ error: 'invalid_request' }, 400);
      const activity = await deps.portal.read(grant.partnerId, query, grant.expiresAt);
      if (!(Date.parse(grant.expiresAt) > Date.now())) return reply({ error: 'access_unavailable' }, 503);
      return reply({ partner: { id: grant.partnerId, code: grant.code }, credentials: grant.credentials, hasMoreCredentials: grant.hasMoreCredentials,
        quota: modern ? quota : { configured: false }, catalog: [{ product: 'vida_hipotecario', operations: [{ method: 'POST', path: '/api/v1/quotes', scope: 'quotes:create' }, { method: 'POST', path: '/api/v1/partner/offers', scope: 'partner-offers:create' }] }],
        versions: deps.versions, period: { ...query, timeZone: 'UTC' }, ...activity }, 200);
    } catch { return reply({ error: 'portal_unavailable' }, 503); }
    finally { clearTimeout(timer); }
  });
}

function validQuota(v: unknown): v is {configured:true;limit:number;used:number;remaining:number;windowStart:string;resetsAt:string;trackingSince:string;updatedAt:string;timeZone:'UTC'} {
  if (!record(v) || v.configured!==true || v.timeZone!=='UTC') return false;
  if (![v.limit,v.used,v.remaining].every(x=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0) || typeof v.limit!=='number'||v.limit<1
    ||typeof v.used!=='number'||v.remaining!==Math.max(0,v.limit-v.used)) return false;
  if (!instant(v.windowStart)||!instant(v.resetsAt)||!instant(v.trackingSince)||!instant(v.updatedAt)) return false;
  const at=Date.parse(v.updatedAt),start=Date.parse(v.windowStart),end=Date.parse(v.resetsAt);
  return v.windowStart===new Date(start).toISOString().slice(0,10)+'T00:00:00.000Z' && end-start===86400000 && at>=start&&at<end
    &&Date.parse(v.trackingSince)<=at && at<=Date.now()+5500 && at>Date.now()-5500;
}
