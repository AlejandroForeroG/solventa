/// <reference path="../worker-configuration.d.ts" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createHttp } from './adapters/inbound/http';
import { databaseProbe } from './adapters/outbound/database-probe';
import { createPolicyFinance } from './adapters/composition';
import { object, UUID } from './domain/financial';

export { createPolicyFinance } from './adapters/composition';

// Composition root: platform wiring and operational probes stay outside the core.
export default class extends WorkerEntrypoint<PolicyEnv & { FINANCIAL_EVENT_KEY?: string }> {
  async fetch(request: Request): Promise<Response> {
    return createHttp({ finance: createPolicyFinance(this.env),
      authorizeFinancialAccess: input => this.env.IDENTITY_SERVICE.authorizeFinancialAccessV1(input),
      denyResourceAccess: input => this.env.IDENTITY_SERVICE.denyResourceAccessV1(input)
    }).fetch(request, this.env, this.ctx);
  }
  async acceptOfferV1(input: unknown) {
    const traceId = object(input) && typeof input.correlationId === 'string' && UUID.test(input.correlationId) ? input.correlationId : crypto.randomUUID();
    return createPolicyFinance(this.env).acceptOffer(input, traceId);
  }
  async queue(batch: MessageBatch<unknown>): Promise<void> {
    const finance = createPolicyFinance(this.env);
    for (const message of batch.messages) {
      const body = message.body;
      const traceId = object(body) && typeof body.correlationId === 'string' && UUID.test(body.correlationId) ? body.correlationId : crypto.randomUUID();
      const result = object(body) && body.eventType === 'offer.accepted'
        ? await finance.acceptOffer(body, traceId) : await finance.consumeParametricEvent(body, traceId);
      if (result.status === 'unavailable') message.retry({ delaySeconds: Math.min(60, 2 ** Math.min(message.attempts, 5)) });
      else message.ack();
    }
  }
  liveness() { return { service: 'policy-claims-payments', environment: this.env.APP_ENV }; }
  async infraStatus() {
    const probe = await databaseProbe(this.env.POLICY_DB.connectionString);
    const database = probe.ready && probe.databaseName === `solventa_${this.env.APP_ENV}`;
    return { service: 'policy-claims-payments', environment: this.env.APP_ENV, databaseName: probe.databaseName, ready: database, database, databaseCode: probe.code };
  }
}
