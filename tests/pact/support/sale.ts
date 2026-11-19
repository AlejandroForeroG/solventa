import { createHttp as createIdentityHttp } from '../../../backend/identity-consent-ecosystem/src/adapters/inbound/http';
import { createHttp as createAcquisitionHttp } from '../../../backend/acquisition-risk/src/adapters/inbound/http';
import { AdvisorSaleAuthorizations } from '../../../backend/identity-consent-ecosystem/src/application/advisor-sale-authorizations';
import { CreateQuote } from '../../../backend/acquisition-risk/src/application/create-quote';
import { EstimateQuote } from '../../../backend/acquisition-risk/src/application/estimate-quote';
import type { AdvisorOffers } from '../../../backend/acquisition-risk/src/application/advisor-offers';
import { MemoryAdvisorSaleAuthorizations } from '../../support/advisor-sale-fakes';
import { InMemoryAccess, MemoryStore, protector } from '../../support/quote-fakes';

export const saleIds = { advisorReference: '03000000-0000-4000-8000-000000000001', authorizationId: '03000000-0000-4000-8000-000000000002', offerId: '03000000-0000-4000-8000-000000000003',
  advisorClientId: '03000000-0000-4000-8000-000000000004', customerClientId: '11111111-1111-4111-8111-111111111111' };

export type SaleMode = 'empty' | 'authorized' | 'unavailable';

// The real customer routes and use case run over an in-memory store; the session is the one the consent states already simulate.
export async function saleIdentityApp(mode: SaleMode, deps: Omit<Parameters<typeof createIdentityHttp>[0], 'advisorSaleAuthorizations'>) {
  const now = () => new Date('2026-11-11T12:00:00.000Z');
  const store = new MemoryAdvisorSaleAuthorizations(new Map([[saleIds.advisorReference, saleIds.advisorClientId]]), now, () => saleIds.authorizationId);
  if (mode === 'unavailable') {
    const failing = { grant: async () => { throw Error('store_down'); }, list: async () => { throw Error('store_down'); }, revoke: async () => { throw Error('store_down'); }, find: async () => null };
    return createIdentityHttp({ ...deps, advisorSaleAuthorizations: new AdvisorSaleAuthorizations({ store: failing, now }) });
  }
  const service = new AdvisorSaleAuthorizations({ store, now });
  if (mode === 'authorized') await service.grant({ principal: { clientId: saleIds.customerClientId, subjectToken: '21111111-1111-4111-8111-111111111111' }, body: { advisorReference: saleIds.advisorReference }, traceId: '50000000-0000-4000-8000-000000000001' });
  return createIdentityHttp({ ...deps, advisorSaleAuthorizations: service });
}

const offer = { offerId: saleIds.offerId, quoteId: 'COT-2026-00001', status: 'definitive' as const, contractable: true, premium: '77760.0000', currency: 'COP' as const,
  coverage: { kind: 'mortgage_life', sumInsured: '320000000.0000' }, validity: { effectiveFrom: '2026-11-12T00:00:00.000Z', effectiveUntil: '2027-11-12T00:00:00.000Z', expiresAt: '2026-11-12T12:00:00.000Z' },
  signals: ['income_obligations_12m', 'payment_history_score', 'affiliation_regime', 'identity_validation'].map(scope => ({ scope, quality: 'live', degraded: false, confidence: 100, capturedAt: '2026-11-11T12:00:00.000Z' })),
  explanation: { ratingVersion: 'academic-mortgage-1', underwritingVersion: 'academic-mortgage-1', baseRatePpm: 1000, adjustmentPpm: 0 }, synthetic: true as const };

// The advisor route is real; the use case answers fixed synthetic results whose rules are covered by the journey suites.
export function saleAcquisitionApp(mode: 'ready' | 'forbidden' | 'consent_required' | 'unavailable') {
  const advisorOffers = { create: async () => mode === 'ready' ? { status: 'created' as const, offer }
    : mode === 'unavailable' ? { status: 'denied' as const, error: 'access_unavailable' as const, httpStatus: 503 as const }
    : { status: 'denied' as const, error: mode, httpStatus: 403 as const } } as unknown as AdvisorOffers;
  return createAcquisitionHttp({ quotes: new CreateQuote({ access: new InMemoryAccess(), store: new MemoryStore(), clock: { now: () => new Date('2026-11-11T12:00:00Z') }, protector }), estimates: new EstimateQuote(), advisorOffers });
}
