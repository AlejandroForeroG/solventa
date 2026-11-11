import { fetchWithSession } from '../session-fetch';

export type PortalData = {
  traceId: string; partner: { id: string; code: string }; credentials: { id: string; scopes: string[]; expiresAt: string; status: 'active' | 'expired' | 'revoked' }[];
  hasMoreCredentials: boolean; quota: { configured: false }; catalog: { product: 'vida_hipotecario'; operations: { method: 'POST'; path: string; scope: string }[] }[];
  versions: { id: string; deprecatedAt?: string; sunset?: string }[]; period: { from: string; to: string; timeZone: 'UTC' }; updatedAt: string;
  totals: { completed: number; accepted: number; preliminary: number; declined: number };
  items: { id: string; reference: string; kind: 'quote' | 'offer_decision'; occurredAt: string; result: 'completed' | 'accepted' | 'preliminary' | 'declined'; ruleVersion: string }[]; hasMore: boolean;
};
export type PortalOutcome = { kind: 'ok'; value: PortalData } | { kind: 'unauthenticated' | 'forbidden' | 'invalid' | 'unavailable'; traceId?: string };
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const instant = (v: unknown): v is string => {
  if (typeof v !== 'string') return false;
  const m = /^(\d{4})-(0[1-9]|1[0-2])-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/.exec(v);
  return !!m && Number(m[3]) >= 1 && Number(m[3]) <= new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate() && Number.isFinite(Date.parse(v));
};
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export function isPortalData(v: unknown): v is PortalData {
  if (!record(v) || !uuid(v.traceId) || !record(v.partner) || !uuid(v.partner.id) || !text(v.partner.code) || !record(v.quota) || v.quota.configured !== false
    || !record(v.period) || !date(v.period.from) || !date(v.period.to) || v.period.timeZone !== 'UTC' || !instant(v.updatedAt)
    || !record(v.totals) || !['completed','accepted','preliminary','declined'].every(k => integer(v.totals && record(v.totals) ? v.totals[k] : null))
    || typeof v.hasMore !== 'boolean' || typeof v.hasMoreCredentials !== 'boolean') return false;
  if (!Array.isArray(v.credentials) || v.credentials.length > 20 || !v.credentials.every(c => record(c) && uuid(c.id) && instant(c.expiresAt)
    && typeof c.status === 'string' && ['active','expired','revoked'].includes(c.status) && Array.isArray(c.scopes) && c.scopes.length <= 32 && c.scopes.every(text))) return false;
  if (!Array.isArray(v.versions) || !v.versions.length || !v.versions.every(x => record(x) && typeof x.id === 'string' && /^v[1-9]\d*$/.test(x.id)
    && (x.deprecatedAt === undefined || date(x.deprecatedAt)) && (x.sunset === undefined || date(x.sunset)))) return false;
  if (!Array.isArray(v.catalog) || !v.catalog.every(x => record(x) && x.product === 'vida_hipotecario' && Array.isArray(x.operations) && x.operations.every(o => record(o)
    && o.method === 'POST' && ((o.path === '/api/v1/quotes' && o.scope === 'quotes:create') || (o.path === '/api/v1/partner/offers' && o.scope === 'partner-offers:create'))))) return false;
  if (!Array.isArray(v.items) || v.items.length > 20 || !v.items.every(x => record(x) && uuid(x.id) && text(x.reference) && instant(x.occurredAt) && text(x.ruleVersion)
    && ((x.kind === 'quote' && x.result === 'completed') || (x.kind === 'offer_decision' && typeof x.result === 'string' && ['accepted','preliminary','declined'].includes(x.result))))) return false;
  return true;
}
export async function readPartnerPortal(from: string, to: string, signal: AbortSignal): Promise<PortalOutcome> {
  try {
    const response = await fetchWithSession('/api/v1/partner-portal?' + new URLSearchParams({ from, to }), { method: 'GET', cache: 'no-store', signal, headers: { accept: 'application/json' } });
    const body: unknown = await response.json();
    const traceId = record(body) && uuid(body.traceId) ? body.traceId : undefined;
    if (response.status === 401) return { kind: 'unauthenticated', traceId };
    if (response.status === 403) return { kind: 'forbidden', traceId };
    if (response.status === 400) return { kind: 'invalid', traceId };
    return response.status === 200 && isPortalData(body) && body.period.from === from && body.period.to === to ? { kind: 'ok', value: body } : { kind: 'unavailable', traceId };
  } catch { return { kind: 'unavailable' }; }
}
