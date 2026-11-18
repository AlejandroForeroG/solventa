import { fetchWithSession } from '../session-fetch';

export const DESTINATIONS = ['regulator', 'reinsurer'] as const;
export type Destination = typeof DESTINATIONS[number];
export const DELIVERY_STATUSES = ['pending', 'dispatched', 'acknowledged', 'rejected', 'uncertain'] as const;
export type DeliveryStatus = typeof DELIVERY_STATUSES[number];
export type Delivery = { id: string; status: DeliveryStatus; attempts: number; reference: string | null; rejectionCode: string | null; updatedAt: string };
export type Report = { reportId: string; period: string; destination: Destination; revision: number; formatVersion: string; contentHash: string; generatedAt: string;
  manifest: { rowCount: number }; delivery?: Delivery };
export type ReportsPage = { items: Report[]; next: string | null };
export type ReportsOutcome<T> = { kind: 'ok'; value: T } | { kind: 'unauthenticated' | 'forbidden' | 'invalid' | 'notFound' | 'integrity' | 'unavailable'; traceId?: string };

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const instant = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
function delivery(v: unknown): v is Delivery {
  return record(v) && uuid(v.id) && DELIVERY_STATUSES.some(status => status === v.status) && Number.isSafeInteger(v.attempts) && instant(v.updatedAt)
    && (v.reference === null || typeof v.reference === 'string') && (v.rejectionCode === null || typeof v.rejectionCode === 'string');
}
function report(v: unknown): v is Report {
  return record(v) && uuid(v.reportId) && typeof v.period === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v.period) && DESTINATIONS.some(destination => destination === v.destination)
    && Number.isSafeInteger(v.revision) && typeof v.formatVersion === 'string' && typeof v.contentHash === 'string' && /^[0-9a-f]{64}$/.test(v.contentHash) && instant(v.generatedAt)
    && record(v.manifest) && Number.isSafeInteger(v.manifest.rowCount) && (v.delivery === undefined || delivery(v.delivery));
}

async function call<T>(path: string, init: RequestInit, signal: AbortSignal | undefined, parse: (status: number, body: Record<string, unknown>) => T | null): Promise<ReportsOutcome<T>> {
  try {
    const response = await fetchWithSession(path, { ...init, signal, cache: 'no-store', headers: { accept: 'application/json', ...(init.method === 'POST' ? { 'content-type': 'application/json' } : {}) } });
    const body: unknown = await response.json();
    const traceId = record(body) && uuid(body.traceId) ? body.traceId : undefined;
    if (response.status === 401) return { kind: 'unauthenticated', traceId };
    if (response.status === 403) return { kind: 'forbidden', traceId };
    if (response.status === 400) return { kind: 'invalid', traceId };
    if (response.status === 404) return { kind: 'notFound', traceId };
    if (!record(body) || !traceId) return { kind: 'unavailable', traceId };
    const value = parse(response.status, body);
    return value === null ? { kind: 'unavailable', traceId } : { kind: 'ok', value };
  } catch (error) { if (signal?.aborted) throw error; return { kind: 'unavailable' }; }
}

export const listReports = (query: URLSearchParams, signal: AbortSignal) => call<ReportsPage>(`/api/v1/reports${query.size ? '?' + query : ''}`, { method: 'GET' }, signal,
  (status, body) => status === 200 && Array.isArray(body.items) && body.items.length <= 20 && body.items.every(report) && (body.next === null || uuid(body.next)) ? { items: body.items, next: body.next } : null);
export const generateReport = (input: { period: string; destination: Destination }) => call<{ report: Report; created: boolean }>('/api/v1/reports',
  { method: 'POST', body: JSON.stringify({ ...input, format: 'csv' }) }, undefined, (status, body) => (status === 200 || status === 201) && report(body.report) && typeof body.created === 'boolean' ? { report: body.report, created: body.created } : null);
export const sendReport = (reportId: string) => call<Delivery>(`/api/v1/reports/${reportId}/delivery`, { method: 'POST', body: '{}' }, undefined,
  (status, body) => status === 200 && delivery(body.delivery) ? body.delivery : null);

// The file is read through the authorized route and saved from memory, so a denied or failed download shows its state instead of a JSON page.
export async function downloadReport(reportId: string, file: 'csv' | 'manifest'): Promise<ReportsOutcome<{ blob: Blob; filename: string }>> {
  try {
    const response = await fetchWithSession(`/api/v1/reports/${reportId}/download?file=${file}`, { method: 'GET', cache: 'no-store' });
    if (response.status === 200) {
      const filename = /filename="([A-Za-z0-9._-]{1,120})"/.exec(response.headers.get('content-disposition') ?? '')?.[1];
      return filename ? { kind: 'ok', value: { blob: await response.blob(), filename } } : { kind: 'unavailable' };
    }
    const body: unknown = await response.json().catch(() => null);
    const traceId = record(body) && uuid(body.traceId) ? body.traceId : undefined;
    return { kind: response.status === 401 ? 'unauthenticated' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'notFound' : response.status === 409 ? 'integrity' : response.status === 400 ? 'invalid' : 'unavailable', traceId };
  } catch { return { kind: 'unavailable' }; }
}
