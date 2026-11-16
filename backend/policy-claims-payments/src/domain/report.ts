import { isClaimState, type ClaimState } from './claims';

export const REPORT_RULE = 'academic-report-1';
export const REPORT_DESTINATIONS = ['regulator', 'reinsurer'] as const;
export type ReportDestinationId = typeof REPORT_DESTINATIONS[number];
export const REPORT_FORMATS = { regulator: 'regulator-portfolio.v1', reinsurer: 'reinsurer-bordereau.v1' } as const;
export type ReportFormatVersion = typeof REPORT_FORMATS[ReportDestinationId];
export const POLICY_EVENT_TYPES = ['policy_issued', 'policy_modified', 'policy_renewed', 'policy_cancelled'] as const;
export type PolicyEventType = typeof POLICY_EVENT_TYPES[number];
export type PaymentOperation = 'premium' | 'indemnity';
export type PaymentState = 'confirmed' | 'refunded';

// Identifiers and amounts only: no client, subject token, document, contact or free text reaches a report.
export type PolicyRow = { type: PolicyEventType; policyId: string; coverageKind: string; eventAt: string; effectiveFrom: string; effectiveUntil: string;
  premium: string; coverageAmount: string; currency: string };
export type ClaimRow = { claimId: string; claimNumber: string | null; policyId: string; state: ClaimState; eventAt: string; estimatedAmount: string | null; currency: string };
export type PaymentRow = { paymentId: string; policyId: string; operation: PaymentOperation; state: PaymentState; eventAt: string; amount: string; currency: string; reference: string | null };
// `group` is `policy_*`, `claim:<state>` or `payment:<operation>:<state>`; `amount` is the premium, estimated claim or payment sum.
export type ReportGroup = { group: string; currency: string; count: number; amount: string };
export type ReportFacts = { policies: PolicyRow[]; claims: ClaimRow[]; payments: PaymentRow[]; aggregates: ReportGroup[] };
export type ReportManifest = { formatVersion: ReportFormatVersion; ruleVersion: typeof REPORT_RULE; synthetic: true; period: string; destination: ReportDestinationId;
  revision: number; generatedAt: string; contentHash: string; rowCount: number; records: Record<string, number>; totals: ReportGroup[] };
export type ReportDelivery = { formatVersion: string; destination: string; deliveryId: string; manifest: ReportManifest; csv: string };

export type ReportErrorCode = 'invalid_period' | 'period_in_future' | 'invalid_fact' | 'reconciliation_failed';
export class ReportError extends Error {
  constructor(readonly code: ReportErrorCode) { super(code); }
}

const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MONEY = /^\d{1,15}\.\d{4}$/;
// Colombia has no daylight saving time, so a fixed UTC-5 offset gives the Bogotá calendar month.
const BOGOTA_OFFSET_HOURS = 5;

export const isReportDestination = (value: unknown): value is ReportDestinationId => REPORT_DESTINATIONS.some(destination => destination === value);

export function periodBounds(period: string): { start: string; end: string } {
  const match = PERIOD.exec(period);
  if (!match || Number(match[1]) < 2000 || Number(match[1]) > 2100) throw new ReportError('invalid_period');
  const year = Number(match[1]), month = Number(match[2]);
  return { start: new Date(Date.UTC(year, month - 1, 1, BOGOTA_OFFSET_HOURS)).toISOString(), end: new Date(Date.UTC(year, month, 1, BOGOTA_OFFSET_HOURS)).toISOString() };
}
export function currentPeriod(now: Date): string {
  const local = new Date(now.getTime() - BOGOTA_OFFSET_HOURS * 3_600_000);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`;
}
export function assertReportablePeriod(period: string, now: Date) {
  periodBounds(period);
  if (period > currentPeriod(now)) throw new ReportError('period_in_future');
}

const units = (amount: string) => {
  if (!MONEY.test(amount)) throw new ReportError('invalid_fact');
  return BigInt(amount.replace('.', ''));
};
const decimal = (value: bigint) => `${value / 10_000n}.${String(value % 10_000n).padStart(4, '0')}`;

const byKey = <T>(key: (item: T) => string) => (left: T, right: T) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0;
const sortGroups = (groups: ReportGroup[]) => [...groups].sort(byKey(group => `${group.group}|${group.currency}`));

export function groupRows(facts: Pick<ReportFacts, 'policies' | 'claims' | 'payments'>): ReportGroup[] {
  const totals = new Map<string, { group: string; currency: string; count: number; amount: bigint }>();
  const add = (group: string, currency: string, amount: bigint) => {
    const key = `${group}|${currency}`;
    const current = totals.get(key) ?? { group, currency, count: 0, amount: 0n };
    current.count += 1; current.amount += amount;
    totals.set(key, current);
  };
  for (const row of facts.policies) add(row.type, row.currency, units(row.premium));
  for (const row of facts.claims) add(`claim:${row.state}`, row.currency, row.estimatedAmount === null ? 0n : units(row.estimatedAmount));
  for (const row of facts.payments) add(`payment:${row.operation}:${row.state}`, row.currency, units(row.amount));
  return sortGroups([...totals.values()].map(total => ({ group: total.group, currency: total.currency, count: total.count, amount: decimal(total.amount) })));
}
// Compared field by field: a manifest read back from JSONB has the same groups with their keys in another order.
const groupKey = (group: ReportGroup) => `${group.group}|${group.currency}|${group.count}|${group.amount}`;
export const sameGroups = (left: ReportGroup[], right: ReportGroup[]) => left.length === right.length
  && sortGroups(left).every((group, index) => groupKey(group) === groupKey(sortGroups(right)[index] as ReportGroup));

const COLUMNS = {
  regulator: ['record_type', 'policy_id', 'coverage_kind', 'operation', 'state', 'event_at', 'effective_from', 'effective_until', 'premium', 'coverage_amount', 'currency', 'count', 'amount'],
  reinsurer: ['record_type', 'policy_id', 'claim_id', 'claim_number', 'payment_id', 'coverage_kind', 'operation', 'state', 'event_at', 'effective_from', 'effective_until',
    'premium', 'coverage_amount', 'reference', 'currency', 'amount']
} as const;
export const reportHeader = (destination: ReportDestinationId) => COLUMNS[destination].join(',');

type Column = typeof COLUMNS[ReportDestinationId][number];
type Row = Partial<Record<Column, string>>;
type Cells = Record<Column, string>;
const ALL_COLUMNS = [...new Set([...COLUMNS.regulator, ...COLUMNS.reinsurer])];
// Every value is an identifier, enum, ISO instant or decimal, so a delimiter inside one is corrupt data and never quoted around.
const line = (destination: ReportDestinationId, row: Row) => COLUMNS[destination].map(column => {
  const value = row[column] ?? '';
  if (/[",\r\n]/.test(value)) throw new ReportError('invalid_fact');
  return value;
}).join(',');

const isPaymentKind = (operation: string, state: string) =>
  (operation === 'premium' || operation === 'indemnity') && (state === 'confirmed' || state === 'refunded');
const policyRow = (row: PolicyRow): Row => ({ record_type: row.type, policy_id: row.policyId, coverage_kind: row.coverageKind, event_at: row.eventAt,
  effective_from: row.effectiveFrom, effective_until: row.effectiveUntil, premium: row.premium, coverage_amount: row.coverageAmount, currency: row.currency });
const splitGroup = (group: ReportGroup) => {
  const [kind, first, second] = group.group.split(':');
  return { kind, first, second, count: String(group.count), amount: group.amount, currency: group.currency };
};

function regulatorRows(facts: ReportFacts, groups: ReportGroup[]): Row[] {
  const totals = groups.filter(group => group.group.includes(':')).map(splitGroup).map(total => total.kind === 'claim'
    ? { record_type: 'claim_total', state: total.first, currency: total.currency, count: total.count, amount: total.amount }
    : { record_type: 'payment_total', operation: total.first, state: total.second, currency: total.currency, count: total.count, amount: total.amount });
  return [...sortedPolicies(facts).map(policyRow), ...totals];
}
function reinsurerRows(facts: ReportFacts): Row[] {
  const claims = [...facts.claims].sort(byKey(row => `${row.eventAt}|${row.claimId}`)).map((row): Row => ({ record_type: 'claim', policy_id: row.policyId, claim_id: row.claimId,
    claim_number: row.claimNumber ?? '', state: row.state, event_at: row.eventAt, currency: row.currency, amount: row.estimatedAmount ?? '' }));
  const payments = [...facts.payments].sort(byKey(row => `${row.eventAt}|${row.paymentId}`)).map((row): Row => ({ record_type: 'payment', policy_id: row.policyId, payment_id: row.paymentId,
    operation: row.operation, state: row.state, event_at: row.eventAt, reference: row.reference ?? '', currency: row.currency, amount: row.amount }));
  return [...sortedPolicies(facts).map(policyRow), ...claims, ...payments];
}
const sortedPolicies = (facts: ReportFacts) => [...facts.policies].sort(byKey(row => `${row.eventAt}|${row.policyId}|${row.type}`));

export function buildReportCsv(destination: ReportDestinationId, facts: ReportFacts): string {
  const rows = destination === 'regulator' ? regulatorRows(facts, groupRows(facts)) : reinsurerRows(facts);
  return [reportHeader(destination), ...rows.map(row => line(destination, row))].join('\n') + '\n';
}

export type ParsedReport = { records: Record<string, number>; groups: ReportGroup[]; rowCount: number };
export type ReportParseCode = 'malformed_csv';

// Reads an artifact back into the totals it declares; a destination uses it to recompute what the manifest claims.
export function parseReportCsv(destination: ReportDestinationId, csv: string): ParsedReport | ReportParseCode {
  const lines = csv.split('\n');
  const columns = COLUMNS[destination];
  if (lines.pop() !== '' || lines.shift() !== reportHeader(destination)) return 'malformed_csv';
  const records: Record<string, number> = {};
  const rows: Pick<ReportFacts, 'policies' | 'claims' | 'payments'> = { policies: [], claims: [], payments: [] };
  const declared: ReportGroup[] = [];
  for (const text of lines) {
    const cells = text.split(',');
    if (cells.length !== columns.length) return 'malformed_csv';
    // A column the destination's format does not have reads as empty, so one mapping serves both formats.
    const row = { ...Object.fromEntries(ALL_COLUMNS.map(column => [column, ''])), ...Object.fromEntries(columns.map((column, index) => [column, cells[index] ?? ''])) } as Cells;
    records[row.record_type] = (records[row.record_type] ?? 0) + 1;
    try {
      if ((POLICY_EVENT_TYPES as readonly string[]).includes(row.record_type)) rows.policies.push({ type: row.record_type as PolicyEventType, policyId: row.policy_id, coverageKind: row.coverage_kind,
        eventAt: row.event_at, effectiveFrom: row.effective_from, effectiveUntil: row.effective_until, premium: row.premium, coverageAmount: row.coverage_amount, currency: row.currency });
      else if (destination === 'regulator' && row.record_type === 'claim_total' && isClaimState(row.state)) declared.push({ group: `claim:${row.state}`, currency: row.currency, count: Number(row.count), amount: row.amount });
      else if (destination === 'regulator' && row.record_type === 'payment_total' && isPaymentKind(row.operation, row.state)) declared.push({ group: `payment:${row.operation}:${row.state}`, currency: row.currency, count: Number(row.count), amount: row.amount });
      else if (destination === 'reinsurer' && row.record_type === 'claim' && isClaimState(row.state)) rows.claims.push({ claimId: row.claim_id, claimNumber: row.claim_number || null,
        policyId: row.policy_id, state: row.state, eventAt: row.event_at, estimatedAmount: row.amount || null, currency: row.currency });
      else if (destination === 'reinsurer' && row.record_type === 'payment' && isPaymentKind(row.operation, row.state))
        rows.payments.push({ paymentId: row.payment_id, policyId: row.policy_id, operation: row.operation as PaymentOperation, state: row.state as PaymentState, eventAt: row.event_at, amount: row.amount, currency: row.currency, reference: row.reference || null });
      else return 'malformed_csv';
    } catch { return 'malformed_csv'; }
  }
  let groups: ReportGroup[];
  try { groups = [...groupRows(rows), ...declared]; } catch { return 'malformed_csv'; }
  if (new Set(groups.map(group => `${group.group}|${group.currency}`)).size !== groups.length || declared.some(group => !Number.isInteger(group.count) || group.count < 1 || !MONEY.test(group.amount))) return 'malformed_csv';
  return { records, groups: sortGroups(groups), rowCount: lines.length };
}

export function buildManifest(input: { destination: ReportDestinationId; period: string; revision: number; generatedAt: string; contentHash: string; csv: string; totals: ReportGroup[] }): ReportManifest {
  const parsed = parseReportCsv(input.destination, input.csv);
  if (typeof parsed === 'string' || !sameGroups(parsed.groups, input.totals)) throw new ReportError('reconciliation_failed');
  return { formatVersion: REPORT_FORMATS[input.destination], ruleVersion: REPORT_RULE, synthetic: true, period: input.period, destination: input.destination,
    revision: input.revision, generatedAt: input.generatedAt, contentHash: input.contentHash, rowCount: parsed.rowCount, records: parsed.records, totals: sortGroups(input.totals) };
}
