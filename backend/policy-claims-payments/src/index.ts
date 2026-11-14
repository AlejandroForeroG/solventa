/// <reference path="../worker-configuration.d.ts" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createHttp } from './adapters/inbound/http';
import { databaseProbe } from './adapters/outbound/database-probe';
import { createPolicyFinance } from './adapters/composition';
import { ClaimInbox } from './application/claim-inbox';
import { SqlClaimInbox } from './adapters/outbound/sql-claim-inbox';
import { ClaimReport } from './application/claim-report';
import { SqlClaimReport } from './adapters/outbound/sql-claim-report';
import { ClaimDrafts } from './application/claim-drafts';
import { SqlClaimDrafts } from './adapters/outbound/sql-claim-drafts';
import { R2ClaimEvidence } from './adapters/outbound/r2-claim-evidence';
import { Sha256ReportDigest } from './adapters/outbound/sha256-report-digest';
import { Reports } from './application/reports';
import { SqlReportStore } from './adapters/outbound/sql-report-store';
import { SqlMockReportDestination } from './adapters/outbound/sql-mock-report-destination';
import { TimerDeadline } from './adapters/outbound/timer-deadline';
import { searchSyntheticAssistance } from './adapters/outbound/synthetic-assistance-directory';
import { object, UUID } from './domain/financial';

export { createPolicyFinance } from './adapters/composition';

const RECONCILIATION_GRACE_MS = 120_000;
const RECONCILIATION_BATCH = 25;

// Composition root: platform wiring and operational probes stay outside the core.
export default class extends WorkerEntrypoint<PolicyEnv & { FINANCIAL_EVENT_KEY?: string; REPORT_DESTINATION_FAULT?: string }> {
  async fetch(request: Request): Promise<Response> {
    const started = performance.now();
    const evidenceBucket: R2Bucket | undefined = this.env.CLAIM_EVIDENCE;
    // The destinations are explicit simulations; the fault switch exists only to show an unanswered delivery locally and defaults to none everywhere.
    const destinationFault = this.env.REPORT_DESTINATION_FAULT === 'timeout' ? 'timeout' : 'none';
    const finance = createPolicyFinance(this.env, { waitUntil: work => this.ctx.waitUntil(work) });
    const response = await createHttp({ finance,
      claimDrafts: { drafts: new ClaimDrafts(new SqlClaimDrafts(this.env.POLICY_DB.connectionString), new Sha256ReportDigest()),
        authorize: input => this.env.IDENTITY_SERVICE.authorizeApiAccessV1(input) },
      advisor: { finance, authorize: input => this.env.IDENTITY_SERVICE.authorizeFinancialAccessV1(input),
        approve: input => this.env.IDENTITY_SERVICE.authorizeAdvisorApprovalV1(input),
        deny: input => this.env.IDENTITY_SERVICE.denyResourceAccessV1(input) },
      authorizeFinancialAccess: input => this.env.IDENTITY_SERVICE.authorizeFinancialAccessV1(input),
      denyResourceAccess: input => this.env.IDENTITY_SERVICE.denyResourceAccessV1(input),
      assistance: { authorize: input => this.env.IDENTITY_SERVICE.authorizeApiAccessV1(input), search: searchSyntheticAssistance },
      claims: { inbox: new ClaimInbox(new SqlClaimInbox(this.env.POLICY_DB.connectionString), { now: () => new Date() }),
        authorize: input => this.env.IDENTITY_SERVICE.authorizeApiAccessV1(input) },
      reports: { reports: new Reports(new SqlReportStore(this.env.POLICY_DB.connectionString), new Sha256ReportDigest(),
        { regulator: new SqlMockReportDestination('regulator', this.env.POLICY_DB.connectionString, destinationFault),
          reinsurer: new SqlMockReportDestination('reinsurer', this.env.POLICY_DB.connectionString, destinationFault) }, { now: () => new Date() }, new TimerDeadline()),
        authorize: input => this.env.IDENTITY_SERVICE.authorizeApiAccessV1(input) },
      // Prod declares no evidence bucket yet, so its upload route fails closed instead of acknowledging a file it cannot keep.
      claimReport: { report: new ClaimReport(new SqlClaimReport(this.env.POLICY_DB.connectionString), evidenceBucket ? new R2ClaimEvidence(evidenceBucket) : undefined, new Sha256ReportDigest(), { now: () => new Date() }),
        authorize: input => this.env.IDENTITY_SERVICE.authorizeApiAccessV1(input) }
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
  // Private Service Binding RPC for the parametric provider; there is deliberately no public route for provider events.
  async receiveParametricEventV1(input: unknown) {
    return createPolicyFinance(this.env, { waitUntil: work => this.ctx.waitUntil(work) }).receiveParametricEvent(input, crypto.randomUUID());
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
    const finance = createPolicyFinance(this.env);
    const staleBefore = new Date(Date.now() - RECONCILIATION_GRACE_MS);
    for (const { traceId, outcome, error } of await finance.reconcileIssuances(staleBefore, RECONCILIATION_BATCH)) {
      console.log(JSON.stringify({ event: 'financial_reconciliation', environment: this.env.APP_ENV, traceId, outcome, ...(error ? { error } : {}) }));
    }
    for (const { traceId, outcome, error } of await finance.reconcileIndemnities(staleBefore, RECONCILIATION_BATCH)) {
      console.log(JSON.stringify({ event: 'indemnity_reconciliation', environment: this.env.APP_ENV, traceId, outcome, ...(error ? { error } : {}) }));
    }
  }
  liveness() { return { service: 'policy-claims-payments', environment: this.env.APP_ENV }; }
  async infraStatus() {
    const probe = await databaseProbe(this.env.POLICY_DB.connectionString);
    const database = probe.ready && probe.databaseName === `solventa_${this.env.APP_ENV}`;
    return { service: 'policy-claims-payments', environment: this.env.APP_ENV, databaseName: probe.databaseName, ready: database, database, databaseCode: probe.code };
  }
}
