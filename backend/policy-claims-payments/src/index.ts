/// <reference path="../worker-configuration.d.ts" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createHttp } from './adapters/inbound/http';
import { databaseProbe } from './adapters/outbound/database-probe';
import { createPolicyFinance } from './adapters/composition';
import { object, UUID } from './domain/financial';

export { createPolicyFinance } from './adapters/composition';

const RECONCILIATION_GRACE_MS = 120_000;
const RECONCILIATION_BATCH = 25;

// Composition root: platform wiring and operational probes stay outside the core.
export default class extends WorkerEntrypoint<PolicyEnv & { FINANCIAL_EVENT_KEY?: string }> {
  async fetch(request: Request): Promise<Response> {
    const started = performance.now();
    const response = await createHttp({ finance: createPolicyFinance(this.env, { waitUntil: work => this.ctx.waitUntil(work) }),
      authorizeFinancialAccess: input => this.env.IDENTITY_SERVICE.authorizeFinancialAccessV1(input),
      denyResourceAccess: input => this.env.IDENTITY_SERVICE.denyResourceAccessV1(input)
    }).fetch(request, this.env, this.ctx);
    if (/^\/api\/v[12]\/policies\//.test(new URL(request.url).pathname)) {
      const placement = request.headers.get('cf-placement') ?? '';
      const traceId = response.headers.get('x-trace-id') ?? '';
      console.log(JSON.stringify({ event: 'financial_http_duration', environment: this.env.APP_ENV,
        ...(UUID.test(traceId) ? { traceId } : {}), status: response.status,
        ...(/^(local|remote)-[A-Z]{3}$/.test(placement) ? { placement } : {}),
        durationMs: Math.round((performance.now() - started) * 100) / 100 }));
    }
    return response;
  }
  async acceptOfferV1(input: unknown) {
    const traceId = object(input) && typeof input.correlationId === 'string' && UUID.test(input.correlationId) ? input.correlationId : crypto.randomUUID();
    return createPolicyFinance(this.env, { waitUntil: work => this.ctx.waitUntil(work) }).acceptOffer(input, traceId);
  }
  async queue(batch: MessageBatch<unknown>): Promise<void> {
    const finance = createPolicyFinance(this.env, { waitUntil: work => this.ctx.waitUntil(work) });
    for (const message of batch.messages) {
      const body = message.body;
      const traceId = object(body) && typeof body.correlationId === 'string' && UUID.test(body.correlationId) ? body.correlationId : crypto.randomUUID();
      const started = performance.now();
      const eventTime = object(body) && typeof body.occurredAt === 'string' ? Date.parse(body.occurredAt) : NaN;
      const ageMs = Number.isFinite(eventTime) ? Math.max(0, Date.now() - eventTime) : null;
      const queueAgeMs = Math.max(0, Date.now() - message.timestamp.getTime());
      const result = object(body) && body.eventType === 'offer.accepted'
        ? await finance.acceptOffer(body, traceId) : await finance.consumeParametricEvent(body, traceId);
      if (result.status === 'unavailable') message.retry({ delaySeconds: Math.min(60, 2 ** Math.min(message.attempts, 5)) });
      else message.ack();
      console.log(JSON.stringify({ event: 'financial_queue_delivery', environment: this.env.APP_ENV, traceId,
        attempts: message.attempts, ageMs, queueAgeMs, processingMs: Math.round((performance.now() - started) * 100) / 100, outcome: result.status }));
    }
  }
  async scheduled(): Promise<void> {
    // The grace period lets an in-flight customer request finish before recovery competes for the same policy.
    const outcomes = await createPolicyFinance(this.env).reconcileIssuances(new Date(Date.now() - RECONCILIATION_GRACE_MS), RECONCILIATION_BATCH);
    for (const { traceId, outcome, error } of outcomes) {
      console.log(JSON.stringify({ event: 'financial_reconciliation', environment: this.env.APP_ENV, traceId, outcome, ...(error ? { error } : {}) }));
    }
  }
  liveness() { return { service: 'policy-claims-payments', environment: this.env.APP_ENV }; }
  async infraStatus() {
    const probe = await databaseProbe(this.env.POLICY_DB.connectionString);
    const database = probe.ready && probe.databaseName === `solventa_${this.env.APP_ENV}`;
    return { service: 'policy-claims-payments', environment: this.env.APP_ENV, databaseName: probe.databaseName, ready: database, database, databaseCode: probe.code };
  }
}
