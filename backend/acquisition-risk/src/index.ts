/// <reference path="../worker-configuration.d.ts" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createHttp } from './adapters/inbound/http';
import { CreateQuote } from './application/create-quote';
import { EstimateQuote } from './application/estimate-quote';
import { databaseProbe } from './adapters/outbound/database-probe';
import { HmacProtector } from './adapters/outbound/hmac-protector';
import { IdentityApiAccess } from './adapters/outbound/identity-api-access';
import { SqlQuoteStore } from './adapters/outbound/sql-quote-store';
import { createOffers } from './adapters/outbound/offer-composition';
import { FinancialOutboxPublisher } from './adapters/outbound/financial-outbox-publisher';
import { HmacOfferIntegrity } from './adapters/outbound/hmac-offer-integrity';
import { signalProviderFor } from './adapters/outbound/signal-providers';

// Composition root: platform wiring and operational probes stay outside the core.
export default class extends WorkerEntrypoint<AcquisitionEnv & { QUOTE_HMAC_KEY?: string; FINANCIAL_EVENT_KEY?: string }> {
  async fetch(request: Request): Promise<Response> {
    const quotes = new CreateQuote({
      access: new IdentityApiAccess(this.env.IDENTITY_SERVICE),
      store: new SqlQuoteStore(this.env.ACQUISITION_DB.connectionString, this.env.APP_ENV === 'dev'),
      clock: { now: () => new Date() },
      protector: new HmacProtector(this.env.QUOTE_HMAC_KEY ?? '')
    });
    return createHttp({ quotes, estimates: new EstimateQuote(), offers: { offers: createOffers(this.env, { waitUntil: work => this.ctx.waitUntil(work) }), authorizeFinancialAccess: input => this.env.IDENTITY_SERVICE.authorizeFinancialAccessV1(input),
      denyResourceAccess: input => this.env.IDENTITY_SERVICE.denyResourceAccessV1(input) } }).fetch(request, this.env, this.ctx);
  }
  async scheduled(): Promise<void> {
    if (!['local', 'dev', 'staging'].includes(this.env.APP_ENV) || this.env.FINANCIAL_PROVIDER_MODE !== 'mock') return;
    const key = this.env.FINANCIAL_EVENT_KEY;
    const queue = this.env.FINANCIAL_EVENTS;
    if (!queue || typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new Error('financial_publisher_configuration_invalid');
    const result = await new FinancialOutboxPublisher({ connectionString: this.env.ACQUISITION_DB.connectionString, environment: this.env.APP_ENV,
      integrity: new HmacOfferIntegrity(key), queue: { send: async event => {
        const delivery = queue.send(event, { contentType: 'json' });
        // A deadline ends this publishing attempt; it cannot cancel a Queue write already in flight.
        this.ctx.waitUntil(delivery.then(() => {}, () => {}));
        await delivery;
      } } }).publish();
    console.log(JSON.stringify({ event: 'financial_outbox_publication', environment: this.env.APP_ENV, ...result }));
  }
  liveness() { return { service: 'acquisition-risk', environment: this.env.APP_ENV }; }
  async infraStatus() {
    const probe = await databaseProbe(this.env.ACQUISITION_DB.connectionString);
    let identity = false;
    try { const target = await this.env.IDENTITY_SERVICE.liveness(); identity = target.service === 'identity-consent-ecosystem' && target.environment === this.env.APP_ENV; } catch {}
    const database = probe.ready && probe.databaseName === `solventa_${this.env.APP_ENV}`;
    // ReadSignal has no route yet; this check keeps an unknown SIGNAL_PROVIDER from deploying unnoticed.
    const signalProvider = signalProviderFor(this.env.SIGNAL_PROVIDER) ? this.env.SIGNAL_PROVIDER : null;
    return { service: 'acquisition-risk', environment: this.env.APP_ENV, databaseName: probe.databaseName, ready: database && identity && signalProvider !== null, database, databaseCode: probe.code, identity, signalProvider };
  }
}
