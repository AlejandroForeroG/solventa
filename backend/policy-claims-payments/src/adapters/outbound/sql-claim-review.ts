import { Client } from 'pg';
import { createHash } from 'node:crypto';
import type { CaseAccess, CaseEvidence, CaseRecord, CaseRequirement, ClaimReviewStore, OwnedCase, ReviewOutcome } from '../../application/claim-review';
import type { ClaimDecisionActor } from '../../application/claim-decisions';
import type { ReportOwner } from '../../application/ports/claim-report';
import { reviewable, type ClaimNotice, type Expert, type RequirementFile, type RequirementResponse, type ReviewAction, type ReviewCommand } from '../../domain/claim-review';
import { isClaimState, type ClaimState } from '../../domain/claims';
import { addClaimNotices } from './sql-claim-notices';

type CaseRow = {
  id: string; claim_number: string; policy_id: string; status: ClaimState; occurred_at: Date; event_type: string | null;
  event_place: string | null; description: string | null; assignee_id: string | null; evidence_required: number; subject_token: string;
};
type AccessView = CaseRecord['access'];
type EvidenceRow = { id: string; content_type: string; byte_size: string; verified_at: Date; object_key: string; checksum_sha256: string };
type RequirementRow = { id: string; details: string; deadline: Date; status: CaseRequirement['status']; response_text: string | null; received_at: Date | null };
type HistoryRow = { id: string; action: string; at: Date; state: string; reason: string | null; expert_id: string | null; expert_name: string | null; actor_id: string | null };
const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const describeEvidence = (row: EvidenceRow): CaseEvidence => ({ id: row.id, contentType: row.content_type, byteSize: Number(row.byte_size), verifiedAt: row.verified_at.toISOString() });

function accessView(row: CaseRow, access: CaseAccess): AccessView | null {
  if (access.kind === 'customer') return row.subject_token === access.actor.subjectToken ? 'customer' : null;
  if (access.actor.subjectToken === row.subject_token) return null;
  if (row.assignee_id === access.actor.clientId) return 'assigned';
  return row.status === 'unassigned' && row.assignee_id === null ? 'unassigned' : null;
}

async function findCase(db: Client, claimId: string, lock = false) {
  const row = (await db.query<CaseRow>(`SELECT c.id,c.claim_number,c.policy_id,c.status,c.occurred_at,c.event_type,c.event_place,c.description,
    c.assignee_id,c.evidence_required::INT4 AS evidence_required,p.subject_token
    FROM policy.claims c JOIN policy.policies p ON p.id=c.policy_id
    WHERE c.id=$1 AND c.claim_number IS NOT NULL AND c.submitted_at IS NOT NULL${lock ? ' FOR UPDATE OF c' : ''}`, [claimId])).rows[0];
  if (row && !isClaimState(row.status)) throw new Error('invalid_stored_claim_state');
  return row;
}

async function checkLease(db: Client, expiresAt: string) {
  if ((await db.query('SELECT 1 WHERE clock_timestamp() < $1::TIMESTAMPTZ', [expiresAt])).rowCount !== 1)
    throw new Error('claims_authorization_expired');
}

async function audit(db: Client, claimId: string, actorId: string, traceId: string, action: string, outcome = 'success', resourceType = 'claim') {
  await db.query(`INSERT INTO policy.audit_events (actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
    VALUES ($1,$2,$6,$3,$4,$5,now()+INTERVAL '90 days')`, [actorId, action, claimId, outcome, traceId, resourceType]);
}

const visibleEvidence = `e.state = 'verified' AND e.retention_until > now() AND
  (NOT EXISTS (SELECT 1 FROM policy.claim_requirement_files rf WHERE rf.evidence_id=e.id)
    OR EXISTS (SELECT 1 FROM policy.claim_requirement_files rf WHERE rf.evidence_id=e.id AND rf.included))`;

export class SqlClaimReview implements ClaimReviewStore {
  constructor(private readonly connectionString: string) {}

  private async transaction<T>(work: (db: Client) => Promise<T>, expiresAt?: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1300, query_timeout: 1300 });
      db.on('error', () => {});
      try {
        if (expiresAt && Date.parse(expiresAt) <= Date.now()) throw new Error('claims_authorization_expired');
        await db.connect();
        await db.query('BEGIN');
        const result = await work(db);
        if (expiresAt) await checkLease(db, expiresAt);
        await db.query('COMMIT');
        return result;
      } catch (error) {
        await db.query('ROLLBACK').catch(() => {});
        if (attempt === 0 && error instanceof Error && 'code' in error && (error.code === '40001' || error.code === '23505')) continue;
        throw error;
      } finally { await db.end().catch(() => {}); }
    }
  }

  owned(owner: ReportOwner, traceId: string): Promise<OwnedCase[]> {
    return this.transaction(async db => {
      const rows = (await db.query<OwnedCase>(`SELECT c.id AS "claimId",c.claim_number AS "claimNumber",c.status AS state
        FROM policy.claims c JOIN policy.policies p ON p.id=c.policy_id
        WHERE p.subject_token=$1 AND c.claim_number IS NOT NULL AND c.submitted_at IS NOT NULL
        ORDER BY c.submitted_at DESC,c.id LIMIT 25`, [owner.subjectToken])).rows;
      if (rows.some(row => !isClaimState(row.state))) throw new Error('invalid_stored_claim_state');
      await audit(db, owner.clientId, owner.clientId, traceId, 'claims.customer.list', 'success', 'claim_list');
      return rows;
    });
  }

  detail(claimId: string, access: CaseAccess, traceId: string): Promise<CaseRecord | null> {
    return this.transaction(async db => {
      const row = await findCase(db, claimId);
      const view = row && accessView(row, access);
      if (!row || !view) {
        await audit(db, claimId, access.actor.clientId, traceId, 'claims.case.read', 'not_found');
        return null;
      }
      const summary = { claimNumber: row.claim_number, policyId: row.policy_id, state: row.status,
        occurredAt: row.occurred_at.toISOString(), eventType: row.event_type, access: view, requiredEvidence: row.evidence_required };
      await audit(db, claimId, access.actor.clientId, traceId, 'claims.case.read');
      if (view === 'unassigned') return { ...summary, place: null, description: null, evidence: [], requirements: [], history: [], notices: [] };
      const evidence = (await db.query<EvidenceRow>(`SELECT e.id,e.content_type,e.byte_size::STRING,e.verified_at,e.checksum_sha256,e.object_key
        FROM policy.evidence_metadata e WHERE e.claim_id=$1 AND ${visibleEvidence} ORDER BY e.created_at,e.id LIMIT 50`, [claimId])).rows.map(describeEvidence);
      const requirements = (await db.query<RequirementRow>(`SELECT id,details,deadline,status,response_text,received_at
        FROM policy.claim_requirements WHERE claim_id=$1 ORDER BY deadline DESC,id LIMIT 25`, [claimId])).rows;
      const attached = requirements.length ? (await db.query<{ requirement_id: string; evidence_id: string }>(
        'SELECT requirement_id,evidence_id FROM policy.claim_requirement_files WHERE requirement_id=ANY($1::UUID[]) AND included', [requirements.map(r => r.id)])).rows : [];
      const history = view === 'assigned' ? (await db.query<HistoryRow>(`
        SELECT * FROM (
          SELECT id,action,created_at AS at,resulting_state AS state,reason,expert_id,expert_name,actor_id
            FROM policy.claim_review_actions WHERE claim_id=$1
          UNION ALL
          SELECT id,action,created_at,resulting_state,reason,NULL,NULL,actor_id FROM policy.claim_decisions WHERE claim_id=$1
          UNION ALL
          SELECT id,'submitted',occurred_at,'unassigned',NULL,NULL,NULL,NULL
            FROM policy.audit_events WHERE resource_id=$1 AND resource_type='claim' AND action='claims.report.submit'
        ) ORDER BY at DESC,id LIMIT 50`, [claimId])).rows.map(item => ({
        id: item.id, action: item.action, at: item.at.toISOString(), state: item.state, reason: item.reason, actorId: item.actor_id,
        expert: item.expert_id && item.expert_name ? { id: item.expert_id, name: item.expert_name } : null
      })) : [];
      const notices = (await db.query<{ event_id: string; action: ClaimNotice; created_at: Date }>(`
        SELECT event_id,action,created_at FROM policy.claim_notices WHERE claim_id=$1 AND audience=$2 AND recipient=$3
        ORDER BY created_at DESC,event_id LIMIT 25`, [claimId, view === 'customer' ? 'customer' : 'analyst',
        access.kind === 'customer' ? access.actor.subjectToken : access.actor.clientId])).rows;
      return { ...summary, description: row.description, place: row.event_place, evidence, history,
        requirements: requirements.map(item => ({ id: item.id, details: item.details, deadline: item.deadline.toISOString(), status: item.status,
          responseText: item.response_text, receivedAt: item.received_at?.toISOString() ?? null,
          evidenceIds: attached.filter(file => file.requirement_id === item.id).map(file => file.evidence_id) })),
        notices: notices.map(item => ({ id: item.event_id, action: item.action, at: item.created_at.toISOString() })) };
    }, access.kind === 'analyst' ? access.actor.expiresAt : undefined);
  }

  evidence(claimId: string, fileId: string, access: CaseAccess, traceId: string) {
    return this.transaction(async db => {
      const row = await findCase(db, claimId);
      const view = row && accessView(row, access);
      if (!view || view === 'unassigned') return null;
      const file = (await db.query<EvidenceRow>(`SELECT e.id,e.object_key,e.content_type,e.byte_size::STRING,e.verified_at,e.checksum_sha256
        FROM policy.evidence_metadata e WHERE e.claim_id=$1 AND e.id=$2 AND ${visibleEvidence}`, [claimId, fileId])).rows[0];
      if (!file) return null;
      await audit(db, claimId, access.actor.clientId, traceId, 'claims.case.evidence');
      return { ...describeEvidence(file), key: file.object_key, sha256: file.checksum_sha256 };
    }, access.kind === 'analyst' ? access.actor.expiresAt : undefined);
  }

  review(claimId: string, actor: ClaimDecisionActor, command: ReviewCommand, key: string, expert?: Expert): Promise<ReviewOutcome> {
    return this.transaction<ReviewOutcome>(async db => {
      const row = await findCase(db, claimId, true);
      const view = row && accessView(row, { kind: 'analyst', actor });
      if (!row || !view) {
        await audit(db, claimId, actor.clientId, actor.traceId, 'claims.review.denied', 'not_found');
        return { status: 'not_found' };
      }
      const replay = await this.replay(db, claimId, actor.clientId, key, command);
      if (replay) return replay;
      if (command.action === 'take' ? view !== 'unassigned' : view !== 'assigned' || !reviewable(row.status)) return { status: 'conflict' };
      if (command.action === 'assign_expert') {
        if (!expert || expert.id !== command.expertId) return { status: 'invalid_request' };
        const existing = await db.query("SELECT 1 FROM policy.claim_review_actions WHERE claim_id=$1 AND action='assign_expert' LIMIT 1", [claimId]);
        if (existing.rowCount) return { status: 'conflict' };
      }
      if (command.action === 'request_information' && !(Date.parse(command.deadline) > Date.now())) return { status: 'invalid_request' };
      const next = command.action === 'request_information' ? 'pending_information' : command.action === 'assign_expert' ? 'escalated' : 'in_review';
      const reason = command.action === 'assign_expert' ? command.reason : null;
      const actionId = await this.record(db, row, actor.clientId, actor.traceId, key, command, next, reason, expert);
      if (command.action === 'request_information') {
        await db.query(`INSERT INTO policy.claim_requirements (id,claim_id,details,deadline) VALUES ($1,$2,$3,$4)`,
          [actionId, claimId, command.details, command.deadline]);
      }
      await this.advance(db, row, next, actor.clientId, actor.traceId, actionId, command.action, actor.clientId, expert?.id);
      return { status: 'ok', actionId, state: next, replayed: false };
    }, actor.expiresAt);
  }

  respond(claimId: string, requirementId: string, owner: ReportOwner, response: RequirementResponse, key: string, traceId: string): Promise<ReviewOutcome> {
    return this.transaction<ReviewOutcome>(async db => {
      const row = await findCase(db, claimId, true);
      if (!row || accessView(row, { kind: 'customer', actor: owner }) !== 'customer') return { status: 'not_found' };
      const command = { action: 'respond' as const, requirementId, ...response };
      const replay = await this.replay(db, claimId, owner.clientId, key, command);
      if (replay) return replay;
      if (!(await this.pending(db, claimId, requirementId)) || row.status !== 'pending_information' || !row.assignee_id)
        return { status: 'conflict' };
      const files = await db.query<{ id: string }>(`SELECT e.id FROM policy.claim_requirement_files rf JOIN policy.evidence_metadata e ON e.id=rf.evidence_id
        WHERE rf.requirement_id=$1 AND e.claim_id=$2 AND e.client_file_id=ANY($3::UUID[]) AND e.state='verified' AND e.retention_until > now()`,
      [requirementId, claimId, response.evidenceIds]);
      if (files.rows.length !== response.evidenceIds.length) return { status: 'invalid_evidence' };
      const actionId = await this.record(db, row, owner.clientId, traceId, key, command, 'in_review', null);
      await db.query(`UPDATE policy.claim_requirements SET status='received',response_text=$3,response_action=$4,received_at=now()
        WHERE claim_id=$1 AND id=$2`, [claimId, requirementId, response.text || null, actionId]);
      await db.query('UPDATE policy.claim_requirement_files SET included=true WHERE requirement_id=$1 AND evidence_id=ANY($2::UUID[])',
        [requirementId, files.rows.map(file => file.id)]);
      await this.advance(db, row, 'in_review', row.assignee_id, traceId, actionId, 'respond', owner.clientId);
      return { status: 'ok', actionId, state: 'in_review', replayed: false };
    });
  }

  prepareFile(claimId: string, requirementId: string, owner: ReportOwner, file: RequirementFile, traceId: string) {
    return this.transaction<Awaited<ReturnType<ClaimReviewStore['prepareFile']>>>(async db => {
      const row = await findCase(db, claimId, true);
      if (!row || row.subject_token !== owner.subjectToken) return { status: 'not_found' };
      const key = `claims/${claimId}/requirements/${requirementId}/${file.fileId}`;
      const existing = (await db.query<{ state: string; object_key: string; content_type: string; byte_size: string; checksum_sha256: string }>(
        'SELECT state,object_key,content_type,byte_size::STRING,checksum_sha256 FROM policy.evidence_metadata WHERE claim_id=$1 AND client_file_id=$2',
        [claimId, file.fileId])).rows[0];
      if (existing) {
        if (existing.object_key !== key || existing.content_type !== file.contentType ||
          Number(existing.byte_size) !== file.byteSize || existing.checksum_sha256 !== file.sha256) return { status: 'conflict' };
        if (existing.state === 'verified') return { status: 'verified', key };
        return await this.pending(db, claimId, requirementId) ? { status: 'pending', key } : { status: 'conflict' };
      }
      if (!await this.pending(db, claimId, requirementId)) return { status: 'conflict' };
      const totals = (await db.query<{ count: number; bytes: string }>(`SELECT count(*)::INT4 AS count,coalesce(sum(e.byte_size),0)::STRING AS bytes
        FROM policy.claim_requirement_files rf JOIN policy.evidence_metadata e ON e.id=rf.evidence_id WHERE rf.requirement_id=$1`, [requirementId])).rows[0];
      if (totals.count >= 3 || Number(totals.bytes) + file.byteSize > 50 * 1024 * 1024) return { status: 'conflict' };
      const id = (await db.query<{ id: string }>(`INSERT INTO policy.evidence_metadata
        (claim_id,object_key,content_type,byte_size,checksum_sha256,retention_until,correlation_id,client_file_id)
        VALUES ($1,$2,$3,$4,$5,now()+INTERVAL '365 days',$6,$7) RETURNING id`,
      [claimId, key, file.contentType, file.byteSize, file.sha256, traceId, file.fileId])).rows[0].id;
      await db.query('INSERT INTO policy.claim_requirement_files (requirement_id,evidence_id) VALUES ($1,$2)', [requirementId, id]);
      return { status: 'pending', key };
    });
  }

  verifyFile(claimId: string, requirementId: string, owner: ReportOwner, fileId: string, traceId: string) {
    return this.transaction(async db => {
      const row = await findCase(db, claimId, true);
      if (!row || row.subject_token !== owner.subjectToken || !await this.pending(db, claimId, requirementId)) return false;
      const updated = await db.query(`UPDATE policy.evidence_metadata e SET state='verified',verified_at=now() FROM policy.claim_requirement_files rf
        WHERE e.id=rf.evidence_id AND e.claim_id=$1 AND rf.requirement_id=$2 AND e.client_file_id=$3 AND e.state<>'verified'`, [claimId, requirementId, fileId]);
      if (updated.rowCount === 1) await audit(db, claimId, owner.clientId, traceId, 'claims.requirement.evidence');
      return updated.rowCount === 1 || (await db.query(`SELECT 1 FROM policy.claim_requirement_files rf JOIN policy.evidence_metadata e ON e.id=rf.evidence_id
        WHERE rf.requirement_id=$1 AND e.claim_id=$2 AND e.client_file_id=$3 AND e.state='verified'`, [requirementId, claimId, fileId])).rowCount === 1;
    });
  }

  private async pending(db: Client, claimId: string, requirementId: string) {
    return (await db.query(`SELECT 1 FROM policy.claim_requirements
      WHERE claim_id=$1 AND id=$2 AND status='pending' AND deadline > clock_timestamp()`, [claimId, requirementId])).rowCount === 1;
  }

  private async replay(db: Client, claimId: string, actorId: string, key: string, command: unknown): Promise<ReviewOutcome | null> {
    const prior = (await db.query<{ id: string; payload_hash: string; resulting_state: ClaimState }>(
      'SELECT id,payload_hash,resulting_state FROM policy.claim_review_actions WHERE claim_id=$1 AND actor_id=$2 AND key_hash=$3', [claimId, actorId, sha256(key)])).rows[0];
    return !prior ? null : prior.payload_hash !== sha256(command) ? { status: 'conflict' }
      : { status: 'ok', actionId: prior.id, state: prior.resulting_state, replayed: true };
  }

  private async record(db: Client, row: CaseRow, actorId: string, traceId: string, key: string, command: { action: ReviewAction },
    state: ClaimState, reason: string | null, expert?: Expert) {
    const id = crypto.randomUUID();
    const payloadHash = sha256(command);
    const capture = { schemaVersion: 1, contractVersion: 'v1', correlationId: traceId,
      inputs: { claimId: row.id, actorId, action: command.action, priorState: row.status, assigneeId: row.assignee_id, payloadHash, expertId: expert?.id ?? null },
      sources: expert ? [{ source: 'synthetic-assistance-directory.v1', capturedAt: new Date().toISOString(), quality: 'simulated' }] : [],
      consent: { status: 'not_required' }, rule: { id: 'claim-review-action', version: '1' }, outcome: state };
    await db.query(`INSERT INTO policy.claim_review_actions
      (id,claim_id,actor_id,key_hash,payload_hash,action,resulting_state,reason,expert_id,expert_name,decision_capture)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::JSONB)`,
    [id, row.id, actorId, sha256(key), payloadHash, command.action, state, reason, expert?.id ?? null, expert?.name ?? null, capture]);
    return id;
  }

  private async advance(db: Client, row: CaseRow, next: ClaimState, analyst: string, traceId: string, eventId: string,
    action: ClaimNotice, actorId: string, expert?: string) {
    await db.query('UPDATE policy.claims SET status=$2,assignee_id=$3,version=version+1,updated_at=now(),correlation_id=$4 WHERE id=$1',
      [row.id, next, analyst, traceId]);
    await audit(db, row.id, actorId, traceId, 'claims.review.' + action, next);
    await addClaimNotices(db, eventId, row.id, action, row.subject_token, analyst, expert);
  }
}
