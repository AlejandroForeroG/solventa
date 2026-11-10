// Product limits and rules for a claim report. The server enforces the same values again; checking them here only saves the customer a failed send.
export const EVENT_TYPES = ['collision', 'theft', 'damage', 'other'] as const;
export type EventType = typeof EVENT_TYPES[number];

export const EVIDENCE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'video/mp4', 'video/quicktime'] as const;
export type EvidenceContentType = typeof EVIDENCE_CONTENT_TYPES[number];

export const LIMITS = {
  files: 10,
  bytes: 50 * 1024 * 1024,
  description: { min: 40, max: 600 },
  place: 120,
  // A phone clock may run slightly ahead of the server.
  futureToleranceMs: 5 * 60_000,
} as const;

export type EvidenceKind = 'photo' | 'video';
export type EvidenceItem = { id: string; uri: string; contentType: EvidenceContentType; byteSize: number; kind: EvidenceKind };
export type EvidenceCandidate = { uri: string; mimeType: string | null; byteSize: number | null };

export type Draft = {
  policyId: string;
  eventType: EventType | null;
  occurredAt: Date;
  place: string;
  description: string;
  evidence: EvidenceItem[];
};
export type PolicyWindow = { from: Date; until: Date };

export type Issue =
  | { field: 'eventType'; code: 'required' }
  | { field: 'occurredAt'; code: 'future' | 'before_coverage' | 'after_coverage' }
  | { field: 'description'; code: 'too_short' | 'too_long' }
  | { field: 'place'; code: 'too_long' }
  | { field: 'evidence'; code: 'none' | 'too_many' | 'total_size' };
export type RejectedCandidate = 'file_type' | 'empty' | 'too_many' | 'total_size' | 'unreadable';

const EXTENSIONS: Record<string, EvidenceContentType> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heic', mp4: 'video/mp4', mov: 'video/quicktime' };
const length = (text: string) => [...text].length;

// Flight delay is parametric and pays without a report, so only mortgage life policies are reportable.
export const isReportableProduct = (product: string): boolean => product === 'vida_hipotecario';

export const kindOf = (contentType: EvidenceContentType): EvidenceKind => contentType.startsWith('video/') ? 'video' : 'photo';

// Picker libraries disagree on spellings such as image/jpg, so the type is normalized and, when absent, taken from the file extension.
export function contentTypeOf(candidate: EvidenceCandidate): EvidenceContentType | null {
  const declared = (candidate.mimeType ?? '').split(';')[0].trim().toLowerCase();
  const normalized = declared === 'image/jpg' || declared === 'image/pjpeg' ? 'image/jpeg' : declared === 'image/heif' ? 'image/heic' : declared;
  const known = EVIDENCE_CONTENT_TYPES.find(type => type === normalized);
  if (known) return known;
  if (declared) return null;
  const extension = candidate.uri.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  return EXTENSIONS[extension] ?? null;
}

export const totalBytes = (evidence: readonly EvidenceItem[]) => evidence.reduce((sum, item) => sum + item.byteSize, 0);

// Adds a picked file only when the whole report would still respect the limits; the reason is returned instead of dropping the file silently.
export function admit(evidence: readonly EvidenceItem[], candidate: EvidenceCandidate, id: string): { item: EvidenceItem } | { rejected: RejectedCandidate } {
  const contentType = contentTypeOf(candidate);
  if (!contentType) return { rejected: 'file_type' };
  if (candidate.byteSize === null || !Number.isSafeInteger(candidate.byteSize)) return { rejected: 'unreadable' };
  if (candidate.byteSize < 1) return { rejected: 'empty' };
  if (evidence.length >= LIMITS.files) return { rejected: 'too_many' };
  if (totalBytes(evidence) + candidate.byteSize > LIMITS.bytes) return { rejected: 'total_size' };
  return { item: { id, uri: candidate.uri, contentType, byteSize: candidate.byteSize, kind: kindOf(contentType) } };
}

export function validate(draft: Draft, window: PolicyWindow, now: Date): Issue[] {
  const issues: Issue[] = [];
  if (!draft.eventType) issues.push({ field: 'eventType', code: 'required' });
  const occurred = draft.occurredAt.getTime();
  if (!(occurred <= now.getTime() + LIMITS.futureToleranceMs)) issues.push({ field: 'occurredAt', code: 'future' });
  else if (occurred < window.from.getTime()) issues.push({ field: 'occurredAt', code: 'before_coverage' });
  else if (occurred > window.until.getTime()) issues.push({ field: 'occurredAt', code: 'after_coverage' });
  const description = length(draft.description.trim());
  if (description < LIMITS.description.min) issues.push({ field: 'description', code: 'too_short' });
  else if (description > LIMITS.description.max) issues.push({ field: 'description', code: 'too_long' });
  if (length(draft.place.trim()) > LIMITS.place) issues.push({ field: 'place', code: 'too_long' });
  if (draft.evidence.length < 1) issues.push({ field: 'evidence', code: 'none' });
  else if (draft.evidence.length > LIMITS.files) issues.push({ field: 'evidence', code: 'too_many' });
  else if (totalBytes(draft.evidence) > LIMITS.bytes) issues.push({ field: 'evidence', code: 'total_size' });
  return issues;
}

export const descriptionLength = (description: string) => length(description.trim());

// What reaches the server: the declared event, never a device path.
export type Manifest = {
  policyId: string;
  eventType: EventType;
  occurredAt: string;
  place?: string;
  description: string;
  evidence: { fileId: string; contentType: EvidenceContentType; byteSize: number; sha256: string }[];
};

export function manifestOf(draft: Draft & { eventType: EventType }, digests: ReadonlyMap<string, string>): Manifest {
  const place = draft.place.trim();
  return {
    policyId: draft.policyId, eventType: draft.eventType, occurredAt: draft.occurredAt.toISOString(),
    ...(place ? { place } : {}), description: draft.description.trim(),
    evidence: draft.evidence.map(item => ({ fileId: item.id, contentType: item.contentType, byteSize: item.byteSize, sha256: digests.get(item.id) ?? '' })),
  };
}
