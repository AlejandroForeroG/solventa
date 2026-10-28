import { OfferService } from '../../application/offer-service';
import { ReadSignal } from '../../application/read-signal';
import { ProviderFailure } from '../../application/ports/signal-sources';
import { SqlOfferStore } from './sql-offer-store';
import { MockFlightSchedule } from './mock-risk-signals';
import { HmacOfferIntegrity } from './hmac-offer-integrity';
import { signalProviderFor } from './signal-providers';
import { SqlSignalSnapshots } from './sql-signal-snapshots';
import { ConsoleDegradationTrace, platformTimer } from './degradation-log';

export type OfferEnvironment = { APP_ENV: string; FINANCIAL_PROVIDER_MODE?: string; FINANCIAL_EVENT_KEY?: string; SIGNAL_PROVIDER?: string; ACQUISITION_DB: { connectionString: string } };
export function createOffers(env: OfferEnvironment, background?: { waitUntil(work: Promise<unknown>): void }) {
  const clock = { now: () => new Date() };
  const provider = signalProviderFor(env.SIGNAL_PROVIDER, clock.now);
  const signals = new ReadSignal({ guard: { verify: async () => ({ allowed: false, reason: 'unavailable' }) },
    provider: provider ?? { read: async () => { throw new ProviderFailure('unavailable'); } }, snapshots: new SqlSignalSnapshots(env.ACQUISITION_DB.connectionString),
    clock, timer: platformTimer, trace: new ConsoleDegradationTrace(), background });
  return new OfferService({ store: new SqlOfferStore(env.ACQUISITION_DB.connectionString, background), signals, flights: new MockFlightSchedule(), integrity: new HmacOfferIntegrity(env.FINANCIAL_EVENT_KEY ?? ''),
    clock, environment: env.APP_ENV, enabled: ['local', 'dev', 'staging'].includes(env.APP_ENV) && env.FINANCIAL_PROVIDER_MODE === 'mock'
      && provider !== null && /^[a-f0-9]{64}$/.test(env.FINANCIAL_EVENT_KEY ?? '') });
}
