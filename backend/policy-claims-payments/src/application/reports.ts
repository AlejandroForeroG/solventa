import { assertReportablePeriod, buildManifest, buildReportCsv, groupRows, periodBounds, ReportError, sameGroups, type ReportDelivery, type ReportDestinationId } from '../domain/report';
import type { ReportDigest } from './ports/claim-report';
import type { DeliveryRecord, DeliveryResult, Deadline, DestinationAnswer, ReportActor, ReportDestination, ReportQuery, ReportStore, RevisionSummary } from './ports/report';

// The 700 ms hard limit of every external call; a destination that has not answered by then leaves the delivery uncertain.
export const DISPATCH_DEADLINE_MS = 700;
export type ReportFile = 'csv' | 'manifest';
export type Download = { status: 'ok'; body: string; contentType: string; filename: string; contentHash: string } | { status: 'not_found' };
export type Sent = { status: 'sent'; delivery: DeliveryRecord; destination: ReportDestinationId; durationMs: number } | { status: 'not_found' };

const isTerminal = (delivery: DeliveryRecord) => delivery.status === 'acknowledged' || delivery.status === 'rejected';

export class Reports {
  constructor(private readonly store: ReportStore, private readonly digest: ReportDigest, private readonly destinations: Record<ReportDestinationId, ReportDestination>,
    private readonly clock: { now(): Date }, private readonly deadline: Deadline, private readonly deadlineMs = DISPATCH_DEADLINE_MS) {}

  async generate(input: { period: string; destination: ReportDestinationId }, actor: ReportActor): Promise<{ report: RevisionSummary; created: boolean }> {
    this.active(actor);
    assertReportablePeriod(input.period, this.clock.now());
    const facts = await this.store.facts(periodBounds(input.period));
    const totals = groupRows(facts);
    if (!sameGroups(totals, facts.aggregates)) throw new ReportError('reconciliation_failed');
    const csv = buildReportCsv(input.destination, facts);
    const contentHash = await this.digest.sha256Hex(csv);
    const saved = await this.store.save({ period: input.period, destination: input.destination, csv, contentHash,
      manifestFor: (revision, generatedAt) => buildManifest({ ...input, revision, generatedAt, contentHash, csv, totals }) }, actor);
    this.active(actor);
    return saved;
  }

  async list(query: ReportQuery, actor: ReportActor) {
    this.active(actor);
    const page = await this.store.list(query, actor);
    this.active(actor);
    return page;
  }

  async download(id: string, file: ReportFile, actor: ReportActor): Promise<Download> {
    this.active(actor);
    const report = await this.store.load(id);
    if (!report) { await this.store.recordDownload(id, 'not_found', actor); return { status: 'not_found' }; }
    if (report.manifest.contentHash !== report.contentHash || await this.digest.sha256Hex(report.content) !== report.contentHash) {
      await this.store.recordDownload(id, 'integrity_failure', actor);
      throw new Error('report_integrity_violation');
    }
    await this.store.recordDownload(id, 'success', actor);
    this.active(actor);
    const name = `${report.destination}-${report.period}-r${report.revision}`;
    return file === 'csv' ? { status: 'ok', body: report.content, contentType: 'text/csv; charset=utf-8', filename: `${name}.csv`, contentHash: report.contentHash }
      : { status: 'ok', body: JSON.stringify(report.manifest), contentType: 'application/json', filename: `${name}.manifest.json`, contentHash: report.contentHash };
  }

  // Dispatch and acknowledgement are different states. The delivery identity belongs to the revision, so a retry asks the destination
  // what it already recorded before sending again, and a confirmed outcome is never repeated.
  async send(id: string, actor: ReportActor): Promise<Sent> {
    this.active(actor);
    const opened = await this.store.openDelivery(id, actor);
    if (!opened) return { status: 'not_found' };
    const { report } = opened;
    const destination = this.destinations[report.destination];
    if (isTerminal(opened.delivery)) return { status: 'sent', delivery: opened.delivery, destination: report.destination, durationMs: 0 };
    const started = this.clock.now().getTime();
    const message: ReportDelivery = { formatVersion: report.formatVersion, destination: report.destination, deliveryId: opened.delivery.id, manifest: report.manifest, csv: report.content };
    let outcome = await this.attempt(destination.lookup(message.deliveryId));
    if (outcome === null) {
      // The lookup may have outlived the lease: nothing is sent once authorization has expired, while an answer already in flight is still recorded below.
      this.active(actor);
      if (!await this.store.markDispatched(message.deliveryId, actor)) return { status: 'sent', delivery: (await this.store.openDelivery(id, actor))?.delivery ?? opened.delivery, destination: report.destination, durationMs: 0 };
      outcome = await this.attempt(destination.deliver(message));
    }
    const result: DeliveryResult = outcome === 'uncertain' || outcome === null ? { status: 'uncertain' }
      : outcome.outcome === 'acknowledged' ? { status: 'acknowledged', reference: outcome.reference } : { status: 'rejected', code: outcome.code };
    const delivery = await this.store.recordDelivery(message.deliveryId, result, actor);
    return { status: 'sent', delivery, destination: report.destination, durationMs: this.clock.now().getTime() - started };
  }

  private async attempt(work: Promise<DestinationAnswer | null>): Promise<DestinationAnswer | null | 'uncertain'> {
    try {
      const answer = await this.deadline.race(work, this.deadlineMs);
      return answer === 'expired' ? 'uncertain' : answer;
    } catch { return 'uncertain'; }
  }
  private active(actor: ReportActor) {
    if (!(Date.parse(actor.expiresAt) > this.clock.now().getTime())) throw new Error('report_authorization_expired');
  }
}
