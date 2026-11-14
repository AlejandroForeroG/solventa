import type { ReportDelivery, ReportDestinationId, ReportFacts, ReportFormatVersion, ReportManifest } from '../../domain/report';

export type ReportActor = { clientId: string; traceId: string; expiresAt: string };
export type DeliveryStatus = 'pending' | 'dispatched' | 'acknowledged' | 'rejected' | 'uncertain';
export type DeliveryRecord = { id: string; status: DeliveryStatus; attempts: number; reference: string | null; rejectionCode: string | null; updatedAt: string };
export type RevisionSummary = { id: string; period: string; destination: ReportDestinationId; revision: number; formatVersion: ReportFormatVersion;
  contentHash: string; manifest: ReportManifest; generatedAt: string; delivery: DeliveryRecord | null };
export type StoredRevision = RevisionSummary & { content: string };
export type ReportQuery = { period?: string; destination?: ReportDestinationId; before?: string };
export type DestinationAnswer = { outcome: 'acknowledged'; reference: string } | { outcome: 'rejected'; code: string };
export type DeliveryResult = { status: 'acknowledged'; reference: string } | { status: 'rejected'; code: string } | { status: 'uncertain' };
export type NewRevision = { period: string; destination: ReportDestinationId; csv: string; contentHash: string;
  // The store assigns the revision number and the generation instant inside its transaction, then asks for the manifest that carries them.
  manifestFor(revision: number, generatedAt: string): ReportManifest };

// Every operation that releases data or changes a delivery records the operator in the owner's audit log in the same transaction.
export interface ReportStore {
  // One consistent snapshot of the persisted facts of the period and, read independently in that snapshot, the totals they must reconcile with.
  facts(range: { start: string; end: string }): Promise<ReportFacts>;
  save(input: NewRevision, actor: ReportActor): Promise<{ report: RevisionSummary; created: boolean }>;
  list(query: ReportQuery, actor: ReportActor): Promise<{ items: RevisionSummary[]; next: string | null }>;
  load(id: string, actor: ReportActor): Promise<StoredRevision | null>;
  openDelivery(id: string, actor: ReportActor): Promise<{ report: StoredRevision; delivery: DeliveryRecord } | null>;
  markDispatched(deliveryId: string, actor: ReportActor): Promise<DeliveryRecord | null>;
  recordDelivery(deliveryId: string, result: DeliveryResult, actor: ReportActor): Promise<DeliveryRecord>;
}
// The adapter translates one destination's protocol; replacing it changes only the adapter and its configuration.
export interface ReportDestination {
  deliver(message: ReportDelivery): Promise<DestinationAnswer>;
  lookup(deliveryId: string): Promise<DestinationAnswer | null>;
}
// The core never touches a platform timer: the adapter supplies the hard limit that leaves a silent destination uncertain.
export interface Deadline { race<T>(work: Promise<T>, milliseconds: number): Promise<T | 'expired'> }
