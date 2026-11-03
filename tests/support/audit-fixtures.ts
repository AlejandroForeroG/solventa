import { underwrite } from '../../backend/acquisition-risk/src/domain/offer';
import type { HistoricalDecision } from '../../backend/acquisition-risk/src/domain/audit-decision';
import type { OfferCapture } from '../../backend/acquisition-risk/src/domain/offer';

export const auditIds = { decision: '90000000-0000-4000-8000-000000000001', offer: '90000000-0000-4000-8000-000000000002', client: '90000000-0000-4000-8000-000000000003', subject: '90000000-0000-4000-8000-000000000004', trace: '90000000-0000-4000-8000-000000000005' };
export function historicalMortgage(declined = false, monthlyObligationsCop = 2000000): HistoricalDecision {
  const at = '2026-10-16T10:00:00.000Z';
  const decision = underwrite({ id: auditIds.decision, quoteId: 'COT-2026-00001', amount: 320000000, ageYears: 35, termMonths: 180, validUntil: '2026-10-17T10:00:00.000Z' }, [
    { scope: 'income_obligations_12m', capturedAt: at, data: { monthlyIncomeCop: 8000000, monthlyObligationsCop } },
    { scope: 'payment_history_score', capturedAt: at, data: { score: declined ? 500 : 780 } },
    { scope: 'affiliation_regime', capturedAt: at, data: { active: true } },
    { scope: 'identity_validation', capturedAt: at, data: { verified: true } }
  ], { consentId: 'CNS-2026-00001', textVersion: 1, expiresAt: '2026-10-16T11:00:00.000Z' }, auditIds.trace);
  if (!decision) throw new Error('invalid_synthetic_fixture');
  return { decisionId: auditIds.decision, decidedAt: at, outcome: decision.capture.outcome, ruleVersion: 'academic-mortgage-1', contractVersion: 'v1', correlationId: auditIds.trace,
    quoteId: 'COT-2026-00001', product: 'vida_hipotecario', snapshot: decision.capture, revisions: declined ? [] : [{ offerId: auditIds.offer, version: 1, premium: decision.premium, currency: 'COP', coverage: { kind: 'mortgage_life', sumInsured: '320000000.0000' }, validFrom: at, expiresAt: '2026-10-17T10:00:00.000Z' }] };
}

export function historicalMockMortgage(): HistoricalDecision {
  const decision = historicalMortgage(false, 1800000);
  const snapshot = structuredClone(decision.snapshot) as OfferCapture;
  for (const field of ['monthlyIncomeCop', 'monthlyObligationsCop', 'identityVerified', 'affiliationActive'] as const) delete snapshot.inputs[field];
  return { ...decision, snapshot };
}
