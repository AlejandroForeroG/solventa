import { OfferService } from '../../application/offer-service';
import { ProviderFailure, type SignalProvider } from '../../application/ports/signal-sources';
import { SqlOfferStore } from './sql-offer-store';
import { MockFlightSchedule } from './mock-flight-schedule';
import { HmacOfferIntegrity } from './hmac-offer-integrity';
import { signalProviderFor } from './signal-providers';

export type OfferEnvironment = { APP_ENV: string; FINANCIAL_PROVIDER_MODE?: string; FINANCIAL_EVENT_KEY?: string; SIGNAL_PROVIDER?: string; ACQUISITION_DB: { connectionString: string } };

// An unknown SIGNAL_PROVIDER disables offers; it never falls back to another source.
const NO_SIGNALS: SignalProvider = { read: async () => { throw new ProviderFailure('unavailable'); } };

export function createOffers(env: OfferEnvironment) {
  const provider = signalProviderFor(env.SIGNAL_PROVIDER);
  return new OfferService({ store: new SqlOfferStore(env.ACQUISITION_DB.connectionString), provider: provider ?? NO_SIGNALS, flights: new MockFlightSchedule(), integrity: new HmacOfferIntegrity(env.FINANCIAL_EVENT_KEY ?? ''),
    clock: { now: () => new Date() }, environment: env.APP_ENV, enabled: provider !== null && ['local', 'dev', 'staging'].includes(env.APP_ENV) && env.FINANCIAL_PROVIDER_MODE === 'mock' && /^[a-f0-9]{64}$/.test(env.FINANCIAL_EVENT_KEY ?? '') });
}
