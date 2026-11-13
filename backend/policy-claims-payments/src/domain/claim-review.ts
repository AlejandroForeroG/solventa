import { isEvidenceContentType, isUuid, MAX_EVIDENCE_BYTES } from './claim-report';
import type { EvidenceContentType } from './claim-report';
import type { ClaimState } from './claims';

export type ReviewCommand =
  | { action: 'take' }
  | { action: 'assign_expert'; expertId: string; reason: string }
  | { action: 'extend_requirement'; requirementId: string; reason: string; deadline: string }
  | { action: 'request_information'; details: string; deadline: string };
export type RequirementResponse = { text: string; evidenceIds: string[] };
export type RequirementFile = { fileId: string; contentType: EvidenceContentType; byteSize: number; sha256: string };
export type ReviewAction = ReviewCommand['action'] | 'respond';
export type ClaimNotice = ReviewAction | 'approve' | 'reject';
export type Expert = { id: string; name: string };
export const reviewable = (state: ClaimState) => state === 'in_review' || state === 'escalated';
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' && v.trim().length >= min && v.trim().length <= max && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v);

export function parseReview(value: unknown): ReviewCommand | null {
  if (!object(value)) return null;
  const keys = Object.keys(value).sort().join(',');
  if (value.action === 'take' && keys === 'action') return { action: 'take' };
  if (value.action === 'assign_expert' && keys === 'action,expertId,reason'
    && typeof value.expertId === 'string' && /^demo-[a-z0-9-]{1,48}$/.test(value.expertId) && text(value.reason, 10, 1000))
    return { action: value.action, expertId: value.expertId, reason: value.reason.trim() };
  if (typeof value.deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.deadline)) return null;
  const deadline = new Date(value.deadline);
  if (!Number.isFinite(deadline.getTime()) || deadline.toISOString() !== value.deadline) return null;
  if (value.action === 'request_information' && keys === 'action,deadline,details' && text(value.details, 10, 1000))
    return { action: value.action, details: value.details.trim(), deadline: value.deadline };
  if (value.action === 'extend_requirement' && keys === 'action,deadline,reason,requirementId'
    && isUuid(value.requirementId) && text(value.reason, 10, 1000))
    return { action: value.action, requirementId: value.requirementId.toLowerCase(), reason: value.reason.trim(), deadline: value.deadline };
  return null;
}

export function parseRequirementResponse(value: unknown): RequirementResponse | null {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'evidenceIds,text' || !text(value.text, 0, 2000)
    || !Array.isArray(value.evidenceIds) || value.evidenceIds.length > 3 || !value.evidenceIds.every(isUuid)) return null;
  const ids = value.evidenceIds.map(id => id.toLowerCase()).sort();
  if ((!value.text.trim() && !ids.length) || new Set(ids).size !== ids.length) return null;
  return { text: value.text.trim(), evidenceIds: ids };
}

export function parseRequirementFile(value: unknown): RequirementFile | null {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'byteSize,contentType,fileId,sha256'
    || !isUuid(value.fileId) || !isEvidenceContentType(value.contentType) || typeof value.byteSize !== 'number'
    || !Number.isSafeInteger(value.byteSize) || value.byteSize < 1 || value.byteSize > MAX_EVIDENCE_BYTES
    || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) return null;
  return { fileId: value.fileId.toLowerCase(), contentType: value.contentType, byteSize: value.byteSize, sha256: value.sha256 };
}
