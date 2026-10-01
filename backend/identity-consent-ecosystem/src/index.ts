/// <reference path="../worker-configuration.d.ts" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createHttp } from './adapters/inbound/http';
import { databaseProbe } from './adapters/outbound/database-probe';

// Composition root: platform wiring and operational probes stay outside the core.
export default class extends WorkerEntrypoint<IdentityEnv> {
  async fetch(request: Request): Promise<Response> {
    return createHttp().fetch(request, this.env, this.ctx);
  }
  liveness() { return { service: 'identity-consent-ecosystem' }; }
  async infraStatus() {
    const probe = await databaseProbe(this.env.IDENTITY_DB.connectionString);
    const database = probe.ready;
    return { service: 'identity-consent-ecosystem', ready: database, database, databaseCode: probe.code };
  }
}
