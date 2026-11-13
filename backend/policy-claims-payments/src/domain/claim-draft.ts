import { isEventType, isUuid, type EventType } from './claim-report';

export type DraftEvidence = { claimId: string; fileId: string };
export type DraftContent = {
  policyId: string;
  eventType: EventType | null;
  occurredAt: string | null;
  place: string;
  description: string;
  evidence: DraftEvidence[];
};
export type DraftVersion = { draftId: string; revision: number; content: DraftContent; updatedAt: string };
export type DraftCommand = {
  commandId: string;
  baseRevision: number;
  content: DraftContent;
  resolution?: { conflictId: string; keep: 'local' | 'server' };
};
export type DraftField = Exclude<keyof DraftContent, 'policyId'>;
export const DRAFT_FIELDS: readonly DraftField[] = ['eventType', 'occurredAt', 'place', 'description', 'evidence'];
export const DRAFT_MERGE_POLICY = 'claim-draft.fields.v1';
export const sameDraftContent = (a: DraftContent, b: DraftContent): boolean => a.policyId === b.policyId && DRAFT_FIELDS.every(field => JSON.stringify(a[field]) === JSON.stringify(b[field]));
export type DraftConflict = {
  conflictId: string; draftId: string; base: DraftVersion | null; server: DraftVersion;
  local: DraftContent; fields: DraftField[]; policy: typeof DRAFT_MERGE_POLICY;
};
export type DraftResult = { status: 'confirmed'; draft: DraftVersion; merged: boolean }
  | { status: 'conflict'; conflict: DraftConflict }
  | { status: 'not_found' | 'policy_unavailable' | 'outside_coverage' | 'evidence_unavailable' | 'invalid_base' | 'idempotency_conflict' | 'limit_reached' };

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every(k => keys.includes(k));
const clean = (v: unknown, max: number): v is string => typeof v === 'string' && [...v].length <= max && !/[^\P{Cc}\n]/u.test(v);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const evidenceKey = (e: DraftEvidence) => `${e.claimId}/${e.fileId}`;

// A saved draft may be incomplete. Only submission can validate a complete report and assign a case number.
export function parseDraftContent(value: unknown): DraftContent | null {
  if (!object(value) || !exact(value, ['policyId', 'eventType', 'occurredAt', 'place', 'description', 'evidence']) || Object.keys(value).length !== 6
    || !isUuid(value.policyId) || !(value.eventType === null || isEventType(value.eventType))
    || !clean(value.place, 120) || /\p{Cc}/u.test(value.place) || !clean(value.description, 600)
    || !Array.isArray(value.evidence) || value.evidence.length > 10) return null;
  if (value.occurredAt !== null && !(typeof value.occurredAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.occurredAt)
    && Number.isFinite(Date.parse(value.occurredAt)) && new Date(value.occurredAt).toISOString() === value.occurredAt)) return null;
  const evidence: DraftEvidence[] = [];
  for (const item of value.evidence) {
    if (!object(item) || !exact(item, ['claimId', 'fileId']) || Object.keys(item).length !== 2 || !isUuid(item.claimId) || !isUuid(item.fileId)) return null;
    evidence.push({ claimId: item.claimId.toLowerCase(), fileId: item.fileId.toLowerCase() });
  }
  if (new Set(evidence.map(evidenceKey)).size !== evidence.length) return null;
  return { policyId: value.policyId.toLowerCase(), eventType: value.eventType, occurredAt: value.occurredAt,
    place: value.place, description: value.description, evidence: evidence.sort((a, b) => evidenceKey(a).localeCompare(evidenceKey(b))) };
}

export function parseDraftCommand(value: unknown): DraftCommand | null {
  if (!object(value) || !exact(value, ['commandId', 'baseRevision', 'content', 'resolution']) || !isUuid(value.commandId)
    || typeof value.baseRevision !== 'number' || !Number.isSafeInteger(value.baseRevision) || value.baseRevision < 0 || value.baseRevision > 1_000_000) return null;
  const content = parseDraftContent(value.content);
  if (!content) return null;
  let resolution: DraftCommand['resolution'];
  if (value.resolution !== undefined) {
    const r = value.resolution;
    if (!object(r) || Object.keys(r).length !== 2 || !exact(r, ['conflictId', 'keep']) || !isUuid(r.conflictId) || (r.keep !== 'local' && r.keep !== 'server')) return null;
    resolution = { conflictId: r.conflictId.toLowerCase(), keep: r.keep };
  }
  return { commandId: value.commandId.toLowerCase(), baseRevision: value.baseRevision, content, ...(resolution ? { resolution } : {}) };
}

// The server obtains the base from its immutable history, never from a caller-supplied snapshot.
// Disjoint or identical field edits commute; simultaneous evidence additions are a set union. A deletion competing with an edit needs a choice.
export function mergeDraft(base: DraftContent, local: DraftContent, server: DraftContent): { content: DraftContent; conflicts: DraftField[] } {
  const content: DraftContent = { ...server, evidence: [...server.evidence] };
  const conflicts: DraftField[] = [];
  for (const field of DRAFT_FIELDS) {
    if (equal(local[field], base[field]) || equal(local[field], server[field])) continue;
    if (equal(server[field], base[field])) {
      switch (field) {
        case 'eventType': content.eventType = local.eventType; break;
        case 'occurredAt': content.occurredAt = local.occurredAt; break;
        case 'place': content.place = local.place; break;
        case 'description': content.description = local.description; break;
        case 'evidence': content.evidence = [...local.evidence]; break;
      }
      continue;
    }
    if (field === 'evidence' && base.evidence.every(e => local.evidence.some(l => evidenceKey(l) === evidenceKey(e)) && server.evidence.some(s => evidenceKey(s) === evidenceKey(e)))) {
      const union = new Map([...server.evidence, ...local.evidence].map(e => [evidenceKey(e), e]));
      if (union.size <= 10) { content.evidence = [...union.values()].sort((a, b) => evidenceKey(a).localeCompare(evidenceKey(b))); continue; }
    }
    conflicts.push(field);
  }
  return { content, conflicts };
}

export function canonicalDraftCommand(draftId: string, command: DraftCommand): string {
  return JSON.stringify(['claim-draft.command.v1', draftId, command.commandId, command.baseRevision, command.content, command.resolution ?? null]);
}

export function draftDecisionCapture(draftId: string, command: DraftCommand, result: DraftResult, traceId: string) {
  return { schemaVersion: 1, contractVersion: 'v1', correlationId: traceId,
    inputs: { draftId, commandId: command.commandId, baseRevision: command.baseRevision,
      ...(result.status === 'confirmed' ? { confirmedRevision: result.draft.revision, merged: result.merged }
        : result.status === 'conflict' ? { serverRevision: result.conflict.server.revision, fields: result.conflict.fields } : {}),
      ...(command.resolution ? { resolution: command.resolution } : {}) },
    sources: [], consent: { status: 'not_required' }, rule: { id: 'claim-draft.fields', version: '1' }, outcome: result.status };
}
