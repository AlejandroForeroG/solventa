/// <reference path="../worker-configuration.d.ts" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createHttp } from './adapters/inbound/http';
import { CreateQuote } from './application/create-quote';
import { databaseProbe } from './adapters/outbound/database-probe';
import { HmacProtector } from './adapters/outbound/hmac-protector';
import { IdentityApiAccess } from './adapters/outbound/identity-api-access';
import { SqlQuoteStore } from './adapters/outbound/sql-quote-store';

// Composition root: platform wiring and operational probes stay outside the core.
export default class extends WorkerEntrypoint<AcquisitionEnv & { QUOTE_HMAC_KEY?: string }> {
  async fetch(request: Request): Promise<Response> {
    const quotes = new CreateQuote({
      access: new IdentityApiAccess(this.env.IDENTITY_SERVICE),
      store: new SqlQuoteStore(this.env.ACQUISITION_DB.connectionString, this.env.APP_ENV === 'dev'),
      clock: { now: () => new Date() },
      protector: new HmacProtector(this.env.QUOTE_HMAC_KEY ?? '')
    });
    return createHttp({ quotes }).fetch(request, this.env, this.ctx);
  }
  liveness() { return { service: 'acquisition-risk', environment: this.env.APP_ENV }; }
  async infraStatus() {
    const probe = await databaseProbe(this.env.ACQUISITION_DB.connectionString);
    let identity = false;
    try { const target = await this.env.IDENTITY_SERVICE.liveness(); identity = target.service === 'identity-consent-ecosystem' && target.environment === this.env.APP_ENV; } catch {}
    const database = probe.ready && probe.databaseName === `solventa_${this.env.APP_ENV}`;
    return { service: 'acquisition-risk', environment: this.env.APP_ENV, databaseName: probe.databaseName, ready: database && identity, database, databaseCode: probe.code, identity };
  }
}
