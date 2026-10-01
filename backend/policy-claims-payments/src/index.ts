/// <reference path="../worker-configuration.d.ts" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createHttp } from './adapters/inbound/http';
import { databaseProbe } from './adapters/outbound/database-probe';

// Composition root: platform wiring and operational probes stay outside the core.
export default class extends WorkerEntrypoint<PolicyEnv> {
  async fetch(request: Request): Promise<Response> {
    return createHttp().fetch(request, this.env, this.ctx);
  }
  liveness() { return { service: 'policy-claims-payments' }; }
  async infraStatus() {
    const probe = await databaseProbe(this.env.POLICY_DB.connectionString);
    const database = probe.ready;
    return { service: 'policy-claims-payments', ready: database, database, databaseCode: probe.code };
  }
}
