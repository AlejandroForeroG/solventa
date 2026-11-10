import { AuthFailure } from '../../authentication/domain/session';
import { validateBaseUrl } from '../../authentication/adapters/solventa-session';
import type { AuthenticatedSession } from '../../policy-wallet/application/ports';
import type { EvidenceItem, Manifest } from '../domain/report';
import { ClaimReportFailure, type ClaimReportApi, type DraftReceipt, type SubmitReceipt } from '../application/ports';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLAIM_NUMBER = /^SIN-\d{4}-\d{5}$/;
const MAX_BODY = 16 * 1024;
const JSON_DEADLINE_MS = 12_000;
const UPLOAD_DEADLINE_MS = 120_000;

export type UploadResult = { status: number; body: string };
// The native layer streams the file from its path, so a video never has to fit in JavaScript memory.
export type EvidenceUploader = (input: { url: string; uri: string; contentType: string; token: string }) => Promise<UploadResult>;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function parse(body: string): Record<string, unknown> {
  if (body.length > MAX_BODY) throw new ClaimReportFailure('invalid_response');
  try { const value: unknown = JSON.parse(body); if (record(value)) return value; } catch { /* handled below */ }
  throw new ClaimReportFailure('invalid_response');
}

// A refusal is classified by its status and the error code the contract names, never by its text.
function failureFor(status: number, body: string): ClaimReportFailure {
  let data: Record<string, unknown> = {};
  try { data = parse(body); } catch { /* an unreadable refusal is classified by status alone */ }
  const error = typeof data.error === 'string' ? data.error : '';
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  if (status === 401) return new ClaimReportFailure('unauthorized');
  if (status === 403) return new ClaimReportFailure('forbidden');
  if (status === 404) return new ClaimReportFailure('not_found');
  if (status === 400) return new ClaimReportFailure('invalid', { fields: strings(data.fields) });
  if (status === 415) return new ClaimReportFailure('media');
  if (status === 409) {
    if (error === 'evidence_incomplete') return new ClaimReportFailure('incomplete', { missing: strings(data.missing) });
    return new ClaimReportFailure('conflict');
  }
  if (status === 422) return new ClaimReportFailure(error === 'outside_coverage' ? 'outside_coverage' : error === 'checksum_mismatch' ? 'integrity' : 'invalid_response');
  if (status === 429 || status >= 500) return new ClaimReportFailure('unavailable');
  return new ClaimReportFailure('invalid_response');
}

export function createClaimReportApi(baseUrl: string, session: AuthenticatedSession, uploader: EvidenceUploader, request: typeof fetch = fetch): ClaimReportApi {
  validateBaseUrl(baseUrl);
  const json = <T>(path: string, init: { method: 'POST'; body?: string; headers?: Record<string, string> }, read: (data: Record<string, unknown>) => T): Promise<T> =>
    session.execute(async token => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), JSON_DEADLINE_MS);
      try {
        const response = await request(`${baseUrl}${path}`, { method: init.method, body: init.body, credentials: 'omit', signal: controller.signal,
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...init.headers } });
        const text = await response.text();
        if (response.status === 401) throw new AuthFailure('unauthorized');
        if (response.status === 403) throw new AuthFailure('forbidden');
        if (!response.ok) throw failureFor(response.status, text);
        if (!response.headers.get('content-type')?.includes('application/json')) throw new ClaimReportFailure('invalid_response');
        return read(parse(text));
      } catch (error) {
        if (error instanceof AuthFailure || error instanceof ClaimReportFailure) throw error;
        throw new ClaimReportFailure('unavailable');
      } finally { clearTimeout(timeout); }
    });

  return {
    createDraft: (manifest: Manifest, idempotencyKey: string): Promise<DraftReceipt> => json('/api/v1/claims', {
      method: 'POST', body: JSON.stringify(manifest), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    }, data => {
      const { claimId, evidence } = data;
      if (typeof claimId !== 'string' || !UUID.test(claimId) || !Array.isArray(evidence)) throw new ClaimReportFailure('invalid_response');
      return { claimId: claimId.toLowerCase(), evidence: evidence.map(file => {
        if (!record(file) || typeof file.fileId !== 'string' || !UUID.test(file.fileId) || (file.state !== 'pending' && file.state !== 'verified')) throw new ClaimReportFailure('invalid_response');
        return { fileId: file.fileId.toLowerCase(), state: file.state };
      }) };
    }),

    upload: (claimId: string, file: EvidenceItem): Promise<void> => session.execute(async token => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          uploader({ url: `${baseUrl}/api/v1/claims/${claimId}/evidence/${file.id}`, uri: file.uri, contentType: file.contentType, token }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ClaimReportFailure('unavailable')), UPLOAD_DEADLINE_MS); }),
        ]);
        if (result.status === 401) throw new AuthFailure('unauthorized');
        if (result.status === 403) throw new AuthFailure('forbidden');
        if (result.status !== 200) throw failureFor(result.status, result.body);
        const data = parse(result.body);
        if (data.state !== 'verified' || data.fileId !== file.id) throw new ClaimReportFailure('invalid_response');
      } catch (error) {
        if (error instanceof AuthFailure || error instanceof ClaimReportFailure) throw error;
        throw new ClaimReportFailure('unavailable');
      } finally { clearTimeout(timer); }
    }),

    submit: (claimId: string): Promise<SubmitReceipt> => json(`/api/v1/claims/${claimId}/submit`, { method: 'POST' }, data => {
      const { claimNumber, submittedAt } = data;
      if (data.claimId !== claimId || typeof claimNumber !== 'string' || !CLAIM_NUMBER.test(claimNumber) || typeof submittedAt !== 'string' || Number.isNaN(Date.parse(submittedAt))) {
        throw new ClaimReportFailure('invalid_response');
      }
      return { claimId, claimNumber, submittedAt };
    }),
  };
}
