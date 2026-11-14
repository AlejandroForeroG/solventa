import { createHash } from 'node:crypto';
import { buildManifest, buildReportCsv, groupRows, type ReportDelivery, type ReportDestinationId, type ReportFacts } from '../../backend/policy-claims-payments/src/domain/report';

export const ids = {
  operator: '90000000-0000-4000-8000-000000000001',
  delivery: '90000000-0000-4000-8000-0000000000d1',
  policy: (n: number) => `90000000-0000-4000-8000-00000000a${String(n).padStart(3, '0')}`,
  claim: (n: number) => `90000000-0000-4000-8000-00000000c${String(n).padStart(3, '0')}`,
  payment: (n: number) => `90000000-0000-4000-8000-00000000b${String(n).padStart(3, '0')}`
};
export const PERIOD = '2026-11';
export const GENERATED_AT = '2026-11-30T12:00:00.000Z';
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

type PolicyRow = ReportFacts['policies'][number];
const policy = (n: number, type: PolicyRow['type'], eventAt: string, premium: string): PolicyRow => ({ type, policyId: ids.policy(n), coverageKind: 'mortgage_life', eventAt,
  effectiveFrom: '2026-11-01T05:00:00.000Z', effectiveUntil: '2027-11-01T05:00:00.000Z', premium, coverageAmount: '148000000.0000', currency: 'COP' });

// Synthetic, with a premium that needs all four decimals so exact decimal sums are exercised.
export function syntheticFacts(): ReportFacts {
  const facts: Omit<ReportFacts, 'aggregates'> = {
    policies: [policy(1, 'policy_issued', '2026-11-03T15:00:00.000Z', '1250000.5000'), policy(2, 'policy_issued', '2026-11-04T16:30:00.000Z', '980000.2500'),
      policy(1, 'policy_modified', '2026-11-10T14:00:00.000Z', '1250000.5000'), policy(3, 'policy_cancelled', '2026-11-12T09:00:00.000Z', '410000.0001')],
    claims: [{ claimId: ids.claim(1), claimNumber: 'SIN-2026-00001', policyId: ids.policy(1), state: 'in_review', eventAt: '2026-11-06T13:00:00.000Z', estimatedAmount: '15000000.0000', currency: 'COP' },
      { claimId: ids.claim(2), claimNumber: null, policyId: ids.policy(2), state: 'paid', eventAt: '2026-11-08T13:00:00.000Z', estimatedAmount: null, currency: 'COP' }],
    payments: [{ paymentId: ids.payment(1), policyId: ids.policy(1), operation: 'premium', state: 'confirmed', eventAt: '2026-11-03T15:01:00.000Z', amount: '1250000.5000', currency: 'COP', reference: `MOCK-${ids.payment(1)}` },
      { paymentId: ids.payment(2), policyId: ids.policy(2), operation: 'indemnity', state: 'confirmed', eventAt: '2026-11-09T10:00:00.000Z', amount: '100000.0000', currency: 'COP', reference: `MOCK-${ids.payment(2)}` },
      { paymentId: ids.payment(3), policyId: ids.policy(3), operation: 'premium', state: 'refunded', eventAt: '2026-11-12T09:05:00.000Z', amount: '410000.0001', currency: 'COP', reference: `MOCK-${ids.payment(3)}` }]
  };
  return { ...facts, aggregates: groupRows(facts) };
}
export const emptyFacts = (): ReportFacts => ({ policies: [], claims: [], payments: [], aggregates: [] });

export function deliveryFor(destination: ReportDestinationId, facts: ReportFacts, revision = 1): ReportDelivery {
  const csv = buildReportCsv(destination, facts);
  const contentHash = sha256(csv);
  const manifest = buildManifest({ destination, period: PERIOD, revision, generatedAt: GENERATED_AT, contentHash, csv, totals: groupRows(facts) });
  return { formatVersion: manifest.formatVersion, destination, deliveryId: ids.delivery, manifest, csv };
}
