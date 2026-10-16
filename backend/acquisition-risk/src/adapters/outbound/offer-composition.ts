import { OfferService } from '../../application/offer-service';
import { SqlOfferStore } from './sql-offer-store';
import { MockFlightSchedule, MockRiskSignals } from './mock-risk-signals';
import { HmacOfferIntegrity } from './hmac-offer-integrity';

export type OfferEnvironment = { APP_ENV: string; FINANCIAL_PROVIDER_MODE?: string; FINANCIAL_EVENT_KEY?: string; ACQUISITION_DB: { connectionString: string } };
export function createOffers(env: OfferEnvironment) {
  return new OfferService({ store: new SqlOfferStore(env.ACQUISITION_DB.connectionString), provider: new MockRiskSignals(), flights: new MockFlightSchedule(), integrity: new HmacOfferIntegrity(env.FINANCIAL_EVENT_KEY ?? ''),
    clock: { now: () => new Date() }, environment: env.APP_ENV, enabled: ['local', 'dev', 'staging'].includes(env.APP_ENV) && env.FINANCIAL_PROVIDER_MODE === 'mock' && /^[a-f0-9]{64}$/.test(env.FINANCIAL_EVENT_KEY ?? '') });
}
