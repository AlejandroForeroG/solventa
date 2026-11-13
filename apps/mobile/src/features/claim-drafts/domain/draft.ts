export type DraftEvidence = { claimId: string; fileId: string };
export type DraftContent = {
  policyId: string; eventType: 'collision' | 'theft' | 'damage' | 'other' | null;
  occurredAt: string | null; place: string; description: string; evidence: DraftEvidence[];
};
export type DraftVersion = { draftId: string; revision: number; content: DraftContent; updatedAt: string };
export type DraftCommand = { commandId: string; baseRevision: number; content: DraftContent; resolution?: { conflictId: string; keep: 'local' | 'server' } };
export type DraftConflict = { conflictId: string; draftId: string; base: DraftVersion | null; server: DraftVersion; local: DraftContent;
  fields: (Exclude<keyof DraftContent, 'policyId'>)[]; policy: 'claim-draft.fields.v1' };
export type SyncReply = { status: 'confirmed'; draft: DraftVersion; merged: boolean } | { status: 'conflict'; conflict: DraftConflict };
export type DraftFailureKind = 'unavailable' | 'invalid_response' | 'rejected' | 'locked' | 'storage' | 'limit' | 'unauthorized';
export class DraftFailure extends Error {
  constructor(public readonly kind: DraftFailureKind) { super(kind); this.name = 'DraftFailure'; }
}
export type DraftEntry = {
  draftId: string; content: DraftContent; confirmed: DraftVersion | null; command: DraftCommand | null;
  status: 'pending' | 'sending' | 'confirmed' | 'conflict' | 'failed';
  attempted: boolean; conflict?: DraftConflict; failure?: DraftFailureKind; savedAt: number;
};
export type DraftOwner = { clientId: string; subjectToken: string };
export type DraftSnapshot = { status: 'locked' | 'loading' | 'failed'; failure?: DraftFailureKind }
  | { status: 'ready'; owner: DraftOwner; entries: readonly DraftEntry[]; failure?: DraftFailureKind };

export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const sameOwner = (a: DraftOwner, b: DraftOwner) => a.clientId === b.clientId && a.subjectToken === b.subjectToken;
export const emptyDraft = (policyId: string): DraftContent => ({ policyId, eventType: null, occurredAt: null, place: '', description: '', evidence: [] });

// Boundary validation is deliberately independent of backend domain code; only the server can decide coverage or ownership.
export function contentOf(raw: unknown): DraftContent {
  if (!object(raw) || Object.keys(raw).length !== 6 || !uuid(raw.policyId) || ![null, 'collision', 'theft', 'damage', 'other'].includes(raw.eventType as string | null)
    || !(raw.occurredAt === null || (typeof raw.occurredAt === 'string' && Number.isFinite(Date.parse(raw.occurredAt)) && new Date(raw.occurredAt).toISOString() === raw.occurredAt))
    || typeof raw.place !== 'string' || [...raw.place].length > 120 || /\p{Cc}/u.test(raw.place)
    || typeof raw.description !== 'string' || [...raw.description].length > 600 || /[^\P{Cc}\n]/u.test(raw.description)
    || !Array.isArray(raw.evidence) || raw.evidence.length > 10) throw new DraftFailure('invalid_response');
  const evidence = raw.evidence.map(e => {
    if (!object(e) || Object.keys(e).length !== 2 || !uuid(e.claimId) || !uuid(e.fileId)) throw new DraftFailure('invalid_response');
    return { claimId: e.claimId.toLowerCase(), fileId: e.fileId.toLowerCase() };
  }).sort((a, b) => `${a.claimId}/${a.fileId}`.localeCompare(`${b.claimId}/${b.fileId}`));
  if (new Set(evidence.map(e => `${e.claimId}/${e.fileId}`)).size !== evidence.length) throw new DraftFailure('invalid_response');
  return { policyId: raw.policyId.toLowerCase(), eventType: raw.eventType as DraftContent['eventType'], occurredAt: raw.occurredAt,
    place: raw.place, description: raw.description, evidence };
}

export function versionOf(raw: unknown): DraftVersion {
  if (!object(raw) || !uuid(raw.draftId) || typeof raw.revision !== 'number' || !Number.isSafeInteger(raw.revision) || raw.revision < 1 || raw.revision > 1_000_000
    || typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt))) throw new DraftFailure('invalid_response');
  return { draftId: raw.draftId.toLowerCase(), revision: raw.revision, content: contentOf(raw.content), updatedAt: raw.updatedAt };
}

export function replyOf(raw: unknown): SyncReply {
  if (!object(raw)) throw new DraftFailure('invalid_response');
  if (raw.status === 'confirmed' && typeof raw.merged === 'boolean') return { status: 'confirmed', draft: versionOf(raw.draft), merged: raw.merged };
  const c = raw.conflict;
  const fields = ['eventType', 'occurredAt', 'place', 'description', 'evidence'];
  if (raw.status !== 'conflict' || !object(c) || !uuid(c.conflictId) || !uuid(c.draftId) || c.policy !== 'claim-draft.fields.v1'
    || !Array.isArray(c.fields) || !c.fields.length || c.fields.some(f => !fields.includes(f)) || new Set(c.fields).size !== c.fields.length) throw new DraftFailure('invalid_response');
  const server = versionOf(c.server); const base = c.base === null ? null : versionOf(c.base); const local = contentOf(c.local);
  if (server.draftId !== c.draftId || (base && (base.draftId !== c.draftId || base.revision >= server.revision)) || local.policyId !== server.content.policyId
    || (base && base.content.policyId !== local.policyId)) throw new DraftFailure('invalid_response');
  return { status: 'conflict', conflict: { conflictId: c.conflictId, draftId: c.draftId, server, base, local,
    fields: c.fields as DraftConflict['fields'], policy: 'claim-draft.fields.v1' } };
}
