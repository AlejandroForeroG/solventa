/// <reference path="../worker-configuration.d.ts" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createHttp } from './adapters/inbound/http';
import { databaseProbe } from './adapters/outbound/database-probe';

// Composition root: platform wiring and operational probes stay outside the core.
export default class extends WorkerEntrypoint<IdentityEnv> {
  async fetch(request: Request): Promise<Response> {
    return createHttp().fetch(request, this.env, this.ctx);
  }
  liveness() { return { service: 'identity-consent-ecosystem', environment: this.env.APP_ENV }; }
  async infraStatus() {
    const probe = await databaseProbe(this.env.IDENTITY_DB.connectionString);
    const database = probe.ready && probe.databaseName === `solventa_${this.env.APP_ENV}`;
    return { service: 'identity-consent-ecosystem', environment: this.env.APP_ENV, databaseName: probe.databaseName, ready: database, database, databaseCode: probe.code };
  }
}
