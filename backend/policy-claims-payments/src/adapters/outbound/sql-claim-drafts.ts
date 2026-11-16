import { Client } from 'pg';
import { DRAFT_MERGE_POLICY, draftDecisionCapture, mergeDraft, sameDraftContent, type DraftCommand, type DraftContent, type DraftResult, type DraftVersion } from '../../domain/claim-draft';
import type { ClaimDraftStore } from '../../application/ports/claim-drafts';
import type { ReportOwner } from '../../application/ports/claim-report';

type Row = { id: string; revision: number; content: DraftContent; updated_at: Date };
const version = (row: Row): DraftVersion => ({ draftId: row.id, revision: row.revision, content: row.content, updatedAt: row.updated_at.toISOString() });

export class SqlClaimDrafts implements ClaimDraftStore {
  constructor(private readonly connectionString: string) {}

  private async transaction<T>(work: (db: Client) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1500, query_timeout: 2000 });
      db.on('error', () => {});
      try {
        await db.connect(); await db.query('BEGIN');
        const result = await work(db);
        await db.query('COMMIT'); return result;
      } catch (error) {
        await db.query('ROLLBACK').catch(() => {});
        if (attempt < 2 && ['40001', '23505'].includes((error as { code?: string }).code ?? '')) continue;
        throw error;
      } finally { await db.end().catch(() => {}); }
    }
  }

  list(owner: ReportOwner): Promise<DraftVersion[]> {
    return this.transaction(async db => (await db.query<Row>(`SELECT d.id, d.revision, d.content, d.updated_at FROM policy.claim_drafts d
      JOIN policy.policies p ON p.id = d.policy_id WHERE d.owner_id = $1 AND d.owner_subject = $2 AND p.subject_token = $2::STRING
      AND p.status = 'issued' ORDER BY d.updated_at DESC, d.id LIMIT 20`, [owner.clientId, owner.subjectToken])).rows.map(version));
  }

  evidence(owner: ReportOwner, policyId: string): Promise<{ claimId: string; fileId: string; contentType: string; createdAt: string }[]> {
    return this.transaction(async db => (await db.query<{ claim_id: string; client_file_id: string; content_type: string; created_at: Date }>(
      `SELECT c.id AS claim_id, e.client_file_id, e.content_type, e.created_at FROM policy.evidence_metadata e
       JOIN policy.claims c ON c.id = e.claim_id JOIN policy.policies p ON p.id = c.policy_id
       WHERE p.id = $1 AND p.subject_token = $2 AND p.status = 'issued' AND e.client_file_id IS NOT NULL
       AND e.state = 'verified' AND e.retention_until > now() ORDER BY e.created_at DESC, e.id LIMIT 50`, [policyId, owner.subjectToken])).rows
      .map(row => ({ claimId: row.claim_id, fileId: row.client_file_id, contentType: row.content_type, createdAt: row.created_at.toISOString() })));
  }

  get(owner: ReportOwner, draftId: string): Promise<DraftVersion | null> {
    return this.transaction(async db => {
      const row = (await db.query<Row>(`SELECT d.id, d.revision, d.content, d.updated_at FROM policy.claim_drafts d
        JOIN policy.policies p ON p.id = d.policy_id WHERE d.id = $1 AND d.owner_id = $2 AND d.owner_subject = $3
        AND p.subject_token = $3::STRING AND p.status = 'issued'`, [draftId, owner.clientId, owner.subjectToken])).rows[0];
      return row ? version(row) : null;
    });
  }

  sync(input: Parameters<ClaimDraftStore['sync']>[0]): Promise<DraftResult> {
    return this.transaction(db => this.apply(db, input));
  }

  private async apply(db: Client, { owner, draftId, command, requestHash, traceId }: Parameters<ClaimDraftStore['sync']>[0]): Promise<DraftResult> {
    const policy = (await db.query<{ effective_from: Date; effective_until: Date; now: Date }>(`SELECT effective_from, effective_until, now() AS now
      FROM policy.policies WHERE id = $1 AND subject_token = $2 AND status = 'issued' FOR UPDATE`, [command.content.policyId, owner.subjectToken])).rows[0];
    if (!policy) return { status: 'policy_unavailable' };
    const occurred = command.content.occurredAt === null ? null : Date.parse(command.content.occurredAt);
    if (occurred !== null && (occurred < policy.effective_from.getTime() || occurred > policy.effective_until.getTime() || occurred > policy.now.getTime() + 300_000)) return { status: 'outside_coverage' };

    const row = (await db.query<Row & { owner_id: string; owner_subject: string }>(`SELECT id, revision, content, updated_at, owner_id, owner_subject FROM policy.claim_drafts WHERE id = $1 FOR UPDATE`, [draftId])).rows[0];
    if (row && (row.owner_id !== owner.clientId || row.owner_subject !== owner.subjectToken || row.content.policyId !== command.content.policyId)) return { status: 'not_found' };
    const previous = (await db.query<{ request_hash: string; draft_id: string; result: { response: DraftResult } }>(`SELECT request_hash, draft_id, result FROM policy.claim_draft_commands
      WHERE owner_subject = $1 AND command_id = $2`, [owner.subjectToken, command.commandId])).rows[0];
    if (previous) return previous.request_hash === requestHash && previous.draft_id === draftId ? previous.result.response : { status: 'idempotency_conflict' };
    if (!row && (command.baseRevision !== 0 || command.resolution)) return { status: 'invalid_base' };
    if (!row && (await db.query<{ n: number }>('SELECT count(*)::INT4 AS n FROM policy.claim_drafts WHERE owner_subject = $1', [owner.subjectToken])).rows[0].n >= 20) return { status: 'limit_reached' };

    let content = command.content;
    let merged = false;
    let base: DraftVersion | null = null;
    if (row) {
      if (command.baseRevision > row.revision) return { status: 'invalid_base' };
      const baseRow = (await db.query<Row>(`SELECT draft_id AS id, revision, content, updated_at FROM policy.claim_draft_revisions WHERE draft_id = $1 AND revision = $2`, [draftId, command.baseRevision])).rows[0];
      if (baseRow) base = version(baseRow);
      if (!base) return { status: 'invalid_base' };
      if (command.resolution) {
        const resolved = await this.resolve(db, owner, draftId, command);
        if (!resolved) return { status: 'invalid_base' };
        content = resolved;
      }
      const decision = mergeDraft(base.content, content, row.content);
      if (decision.conflicts.length) {
        if (!await this.allowedEvidence(db, owner, content) || !await this.allowedEvidence(db, owner, row.content)) return { status: 'evidence_unavailable' };
        const result: DraftResult = { status: 'conflict', conflict: { conflictId: command.commandId, draftId,
          base, local: content, server: version(row), fields: decision.conflicts, policy: DRAFT_MERGE_POLICY } };
        await this.record(db, owner, draftId, command, requestHash, result, traceId, 'conflict');
        return result;
      }
      content = decision.content;
      merged = command.baseRevision !== row.revision;
    }
    if (!await this.allowedEvidence(db, owner, content)) return { status: 'evidence_unavailable' };
    let confirmed: DraftVersion;
    if (row && sameDraftContent(content, row.content)) confirmed = version(row);
    else {
      if (row && row.revision >= 1_000_000) return { status: 'limit_reached' };
      const saved = row
        ? await db.query<Row>(`UPDATE policy.claim_drafts SET content = $2::JSONB, revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING id, revision, content, updated_at`, [draftId, JSON.stringify(content)])
        : await db.query<Row>(`INSERT INTO policy.claim_drafts (id, policy_id, owner_id, owner_subject, revision, content) VALUES ($1, $2, $3, $4, 1, $5::JSONB) RETURNING id, revision, content, updated_at`, [draftId, content.policyId, owner.clientId, owner.subjectToken, JSON.stringify(content)]);
      confirmed = version(saved.rows[0]);
      await db.query(`INSERT INTO policy.claim_draft_revisions (draft_id, revision, content, updated_at, actor_id) VALUES ($1, $2, $3::JSONB, $4, $5)`, [draftId, confirmed.revision, JSON.stringify(content), confirmed.updatedAt, owner.clientId]);
    }
    const result: DraftResult = { status: 'confirmed', draft: confirmed, merged };
    await this.record(db, owner, draftId, command, requestHash, result, traceId, command.resolution ? 'resolved' : merged ? 'merged' : 'saved');
    return result;
  }

  private async resolve(db: Client, owner: ReportOwner, draftId: string, command: DraftCommand): Promise<DraftContent | null> {
    const choice = command.resolution;
    if (!choice) return null;
    const row = (await db.query<{ result: { response: DraftResult } }>(`SELECT result FROM policy.claim_draft_commands WHERE owner_subject = $1 AND command_id = $2 AND draft_id = $3`, [owner.subjectToken, choice.conflictId, draftId])).rows[0];
    if (!row || row.result.response.status !== 'conflict') return null;
    const conflict = row.result.response.conflict;
    if (!conflict.base || conflict.server.revision !== command.baseRevision || !sameDraftContent(command.content, conflict.local)) return null;
    const selected = mergeDraft(conflict.base.content, conflict.local, conflict.server.content).content;
    for (const field of conflict.fields) {
      const source = choice.keep === 'local' ? conflict.local : conflict.server.content;
      Object.assign(selected, { [field]: source[field] });
    }
    return selected;
  }

  private async allowedEvidence(db: Client, owner: ReportOwner, content: DraftContent): Promise<boolean> {
    for (const ref of content.evidence) {
      const found = await db.query(`SELECT 1 FROM policy.evidence_metadata e JOIN policy.claims c ON c.id = e.claim_id
        JOIN policy.policies p ON p.id = c.policy_id WHERE c.id = $1 AND e.client_file_id = $2 AND c.policy_id = $3
        AND p.subject_token = $4 AND e.state = 'verified' AND e.retention_until > now()`, [ref.claimId, ref.fileId, content.policyId, owner.subjectToken]);
      if (found.rowCount !== 1) return false;
    }
    return true;
  }

  private async record(db: Client, owner: ReportOwner, draftId: string, command: DraftCommand, hash: string, result: DraftResult, traceId: string, outcome: string): Promise<void> {
    const recorded = { response: result, capture: draftDecisionCapture(draftId, command, result, traceId) };
    await db.query(`INSERT INTO policy.claim_draft_commands (owner_subject, command_id, draft_id, request_hash, result) VALUES ($1, $2, $3, $4, $5::JSONB)`, [owner.subjectToken, command.commandId, draftId, hash, JSON.stringify(recorded)]);
    await db.query(`INSERT INTO policy.audit_events (actor_reference, action, resource_type, resource_id, outcome, correlation_id, retention_until)
      VALUES ($1, 'claims.draft.sync', 'claim_draft', $2, $3, $4, now() + INTERVAL '90 days')`, [owner.clientId, draftId, outcome, traceId]);
  }
}
