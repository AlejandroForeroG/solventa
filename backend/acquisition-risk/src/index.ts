/// <reference path="../worker-configuration.d.ts" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createHttp } from './adapters/inbound/http';
import { databaseProbe } from './adapters/outbound/database-probe';

// Composition root: platform wiring and operational probes stay outside the core.
export default class extends WorkerEntrypoint<AcquisitionEnv> {
  async fetch(request: Request): Promise<Response> {
    return createHttp().fetch(request, this.env, this.ctx);
  }
  liveness() { return { service: 'acquisition-risk' }; }
  async infraStatus() {
    const probe = await databaseProbe(this.env.ACQUISITION_DB.connectionString);
    let identity = false;
    try { identity = (await this.env.IDENTITY_SERVICE.liveness()).service === 'identity-consent-ecosystem'; } catch {}
    const database = probe.ready;
    return { service: 'acquisition-risk', ready: database && identity, database, databaseCode: probe.code, identity };
  }
}
