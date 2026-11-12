// A customer reports a claim in three owner-side steps: a draft with its evidence manifest, each file, then the submission that numbers the case.
export const EVENT_TYPES = ['collision', 'theft', 'damage', 'other'] as const;
export type EventType = typeof EVENT_TYPES[number];

// Provisional product limits, taken from the approved mobile prototype; the server enforces the same values the app checks first.
export const EVIDENCE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'video/mp4', 'video/quicktime'] as const;
export type EvidenceContentType = typeof EVIDENCE_CONTENT_TYPES[number];
export const MAX_EVIDENCE_FILES = 10;
export const MAX_EVIDENCE_BYTES = 50 * 1024 * 1024;
export const DESCRIPTION_LENGTH = { min: 40, max: 600 } as const;
export const MAX_PLACE_LENGTH = 120;
// One verified file makes a report complete; analysts may require more later.
export const REQUIRED_EVIDENCE = 1;
export const EVIDENCE_RETENTION_DAYS = 365;
export const FUTURE_TOLERANCE_MS = 5 * 60_000;

export type EvidenceItem = { fileId: string; contentType: EvidenceContentType; byteSize: number; sha256: string };
// The customer's position is optional and is stored only when the request authorizes it explicitly. Coordinates keep six decimals, about ten centimetres.
export type ReportLocation = { latitude: number; longitude: number };
export type ReportInput = { policyId: string; eventType: EventType; occurredAt: string; place: string | null; location: ReportLocation | null; description: string; evidence: EvidenceItem[] };
export type ParsedReport = { ok: true; value: ReportInput } | { ok: false; fields: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const length = (text: string) => [...text].length;

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
export const isEvidenceContentType = (value: unknown): value is EvidenceContentType => EVIDENCE_CONTENT_TYPES.some(type => type === value);
export const isEventType = (value: unknown): value is EventType => EVENT_TYPES.some(type => type === value);

// A location is valid only as { authorized: true, latitude, longitude }: without an explicit authorization nothing about it is accepted.
function parseLocation(value: unknown): ReportLocation | null | undefined {
  if (value === undefined) return null;
  if (!record(value) || Object.keys(value).length !== 3 || value.authorized !== true) return undefined;
  const { latitude, longitude } = value;
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return undefined;
  return { latitude: Math.round(latitude * 1e6) / 1e6, longitude: Math.round(longitude * 1e6) / 1e6 };
}

// Only field names are reported, never values: a description, a place or a location may be personal.
export function parseReport(body: unknown, now: Date): ParsedReport {
  const fields = new Set<string>();
  if (!record(body)) return { ok: false, fields: ['body'] };
  const allowed = ['policyId', 'eventType', 'occurredAt', 'place', 'location', 'description', 'evidence'];
  if (Object.keys(body).some(key => !allowed.includes(key))) fields.add('body');
  if (!isUuid(body.policyId)) fields.add('policyId');
  if (!isEventType(body.eventType)) fields.add('eventType');
  const occurred = typeof body.occurredAt === 'string' && TIMESTAMP.test(body.occurredAt) ? Date.parse(body.occurredAt) : NaN;
  if (!Number.isFinite(occurred) || new Date(occurred).toISOString() !== body.occurredAt || occurred > now.getTime() + FUTURE_TOLERANCE_MS) fields.add('occurredAt');
  let place: string | null = null;
  if (body.place !== undefined && body.place !== null) {
    const trimmed = typeof body.place === 'string' ? body.place.trim() : '';
    if (!trimmed || length(trimmed) > MAX_PLACE_LENGTH || /\p{Cc}/u.test(trimmed)) fields.add('place'); else place = trimmed;
  }
  const location = parseLocation(body.location);
  if (location === undefined) fields.add('location');
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (length(description) < DESCRIPTION_LENGTH.min || length(description) > DESCRIPTION_LENGTH.max || /[^\P{Cc}\n]/u.test(description)) fields.add('description');
  const evidence: EvidenceItem[] = [];
  if (!Array.isArray(body.evidence) || body.evidence.length < REQUIRED_EVIDENCE || body.evidence.length > MAX_EVIDENCE_FILES) fields.add('evidence');
  else {
    const seen = new Set<string>();
    let total = 0;
    for (const item of body.evidence) {
      if (!record(item) || Object.keys(item).length !== 4 || !isUuid(item.fileId) || !isEvidenceContentType(item.contentType)
        || !Number.isSafeInteger(item.byteSize) || (item.byteSize as number) < 1 || !(typeof item.sha256 === 'string' && SHA256.test(item.sha256))) { fields.add('evidence'); continue; }
      const fileId = item.fileId.toLowerCase();
      if (seen.has(fileId)) fields.add('evidence');
      seen.add(fileId);
      total += item.byteSize as number;
      evidence.push({ fileId, contentType: item.contentType, byteSize: item.byteSize as number, sha256: (item.sha256 as string).toLowerCase() });
    }
    if (total > MAX_EVIDENCE_BYTES) fields.add('evidence');
  }
  if (fields.size) return { ok: false, fields: [...fields] };
  return { ok: true, value: { policyId: (body.policyId as string).toLowerCase(), eventType: body.eventType as EventType, occurredAt: body.occurredAt as string, place, location: location ?? null, description, evidence } };
}

// The same report yields the same text whatever the order of its files, so hashing it recognizes a retried request and not an altered one.
export function canonicalReport(report: ReportInput): string {
  // The location joins the text only when there is one, so a report without it keeps the text, and the hash, it had before locations existed.
  return JSON.stringify(['claim-report.v1', report.policyId, report.eventType, report.occurredAt, report.place, report.description,
    [...report.evidence].sort((a, b) => a.fileId.localeCompare(b.fileId)).map(item => [item.fileId, item.contentType, item.byteSize, item.sha256]),
    ...(report.location ? [[report.location.latitude, report.location.longitude]] : [])]);
}

export const evidenceObjectKey = (claimId: string, fileId: string) => `claims/${claimId}/${fileId}`;
// Colombia has no daylight saving time, so UTC-5 gives the Bogotá calendar year of the number.
export const claimNumber = (year: number, sequence: number) => `SIN-${year}-${String(sequence).padStart(5, '0')}`;
