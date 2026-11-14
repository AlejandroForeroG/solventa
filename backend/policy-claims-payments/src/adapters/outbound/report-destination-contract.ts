import { createHash } from 'node:crypto';
import { parseReportCsv, REPORT_FORMATS, sameGroups, type ReportDestinationId, type ReportGroup } from '../../domain/report';

export const REJECTION_CODES = ['invalid_message', 'destination_mismatch', 'unsupported_format_version', 'hash_mismatch', 'malformed_csv', 'totals_mismatch'] as const;
export type RejectionCode = typeof REJECTION_CODES[number];
export type Verdict = { outcome: 'acknowledged' } | { outcome: 'rejected'; code: RejectionCode };

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const GROUP = /^(policy_(issued|modified|renewed|cancelled)|claim:[a-z_]+|payment:(premium|indemnity):(confirmed|refunded))$/;
const isGroup = (value: unknown): value is ReportGroup => record(value) && typeof value.group === 'string' && GROUP.test(value.group) && typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency)
  && Number.isInteger(value.count) && (value.count as number) >= 1 && typeof value.amount === 'string' && /^\d{1,15}\.\d{4}$/.test(value.amount);
const KEYS = ['formatVersion', 'destination', 'deliveryId', 'manifest', 'csv'];
const MANIFEST_KEYS = ['formatVersion', 'ruleVersion', 'synthetic', 'period', 'destination', 'revision', 'generatedAt', 'contentHash', 'rowCount', 'records', 'totals'];

// What a destination checks before it answers: its own versioned format, the artifact hash, and the totals it recomputes from the rows.
// A rejection is a consequence of the delivered content, never of who sent it.
export function reviewDelivery(destination: ReportDestinationId, message: unknown): Verdict {
  const rejected = (code: RejectionCode): Verdict => ({ outcome: 'rejected', code });
  if (!record(message) || Object.keys(message).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(message, key))
    || typeof message.csv !== 'string' || typeof message.deliveryId !== 'string' || typeof message.formatVersion !== 'string' || typeof message.destination !== 'string') return rejected('invalid_message');
  const manifest = message.manifest;
  if (!record(manifest) || Object.keys(manifest).length !== MANIFEST_KEYS.length || MANIFEST_KEYS.some(key => !Object.hasOwn(manifest, key))
    || typeof manifest.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.contentHash) || !Array.isArray(manifest.totals) || !manifest.totals.every(isGroup)
    || !record(manifest.records) || !Number.isInteger(manifest.rowCount)) return rejected('invalid_message');
  if (message.destination !== destination || manifest.destination !== destination) return rejected('destination_mismatch');
  if (message.formatVersion !== REPORT_FORMATS[destination] || manifest.formatVersion !== REPORT_FORMATS[destination]) return rejected('unsupported_format_version');
  if (createHash('sha256').update(message.csv).digest('hex') !== manifest.contentHash) return rejected('hash_mismatch');
  const parsed = parseReportCsv(destination, message.csv);
  if (typeof parsed === 'string') return rejected(parsed);
  if (!sameGroups(parsed.groups, manifest.totals as ReportGroup[]) || parsed.rowCount !== manifest.rowCount || JSON.stringify(sortKeys(parsed.records)) !== JSON.stringify(sortKeys(manifest.records))) return rejected('totals_mismatch');
  return { outcome: 'acknowledged' };
}
const sortKeys = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : 1));
