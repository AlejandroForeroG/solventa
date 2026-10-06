/// <reference path="../worker-configuration.d.ts" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createHttp } from './adapters/inbound/http';
import { databaseProbe } from './adapters/outbound/database-probe';

// Composition root: platform wiring and operational probes stay outside the core.
export default class extends WorkerEntrypoint<AcquisitionEnv> {
  async fetch(request: Request): Promise<Response> {
    return createHttp().fetch(request, this.env, this.ctx);
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
