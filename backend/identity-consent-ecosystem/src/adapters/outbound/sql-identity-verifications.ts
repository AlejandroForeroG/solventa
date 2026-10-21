import { Client } from 'pg';
import type { Integrity } from '../../application/ports/consents';
import type { VerificationCommand, VerificationContext, VerificationOperation, VerificationPlan, VerificationStore } from '../../application/ports/identity-verification';
import { canonicalVerificationContent, VerificationFailure } from '../../domain/identity-verification';
import type { VerificationState } from '../../domain/identity-verification';

type StateRow = { id: string; client_id: string; is_current: boolean; version: string; state: VerificationState; seal: string };
type CommandRow = { case_id: string; command: VerificationCommand; seal: string };

export class SqlIdentityVerifications implements VerificationStore {
  constructor(private readonly connectionString: string, private readonly integrity: Integrity) {}

  async execute<T>(input: VerificationOperation, decide: (context: VerificationContext) => Promise<VerificationPlan<T>>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.once(input, decide); }
      catch (error) {
        // A serialization rejection is a known rollback. Never retry an uncertain network/commit failure.
        if (!(error && typeof error === 'object' && 'code' in error && error.code === '40001') || attempt >= 2) throw error;
      }
    }
  }

  private async once<T>(input: VerificationOperation, decide: (context: VerificationContext) => Promise<VerificationPlan<T>>): Promise<T> {
    if (!input.identity.emailVerified || !input.identity.providerSubject || !input.identity.sessionReference) throw new VerificationFailure('unauthorized', 401);
    const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1500, query_timeout: 2000, statement_timeout: 1800 });
    db.on('error', () => {});
    try {
      await db.connect();
      await db.query('BEGIN');
      // The client lock also serializes grants made through different sessions of the same owner.
      const session = (await db.query<{ client_id: string; subject_token: string; status: string; expires_at: Date; revoked_at: Date | null }>(`
        SELECT c.id AS client_id,c.subject_token,c.status,s.expires_at,s.revoked_at
        FROM identity.authentication_sessions s JOIN identity.clients c ON c.id=s.client_id
        JOIN identity.external_identities e ON e.client_id=c.id AND e.provider='workos'
        WHERE s.provider='workos' AND s.provider_session=$1 AND e.provider_subject=$2 FOR UPDATE OF s,c`,
      [input.identity.sessionReference, input.identity.providerSubject])).rows[0];
      if (!session) throw new VerificationFailure('unauthorized', 401);
      const commandRow = input.command ? (await db.query<CommandRow>(`
        SELECT case_id,command,seal FROM identity.identity_verification_commands
        WHERE client_id=$1 AND idempotency_key=$2 FOR UPDATE`, [session.client_id, input.command.key])).rows[0] : undefined;
      if (commandRow && (commandRow.command.key !== input.command?.key || commandRow.command.caseId !== commandRow.case_id
        || await this.integrity.seal(canonicalVerificationContent({ clientId: session.client_id, command: commandRow.command })) !== commandRow.seal)) {
        throw new Error('verification_command_invalid');
      }
      const caseId = input.caseId ?? commandRow?.case_id;
      const row = (await db.query<StateRow>(`
        SELECT id,client_id,is_current,version,state,seal FROM identity.identity_verifications
        WHERE client_id=$1 AND ${caseId ? 'id=$2' : 'is_current=true'} FOR UPDATE`,
      caseId ? [session.client_id, caseId] : [session.client_id])).rows[0];
      if (row && (row.state.id !== row.id || row.state.clientId !== row.client_id || row.state.version !== Number(row.version)
        || await this.seal(row.state, row.is_current) !== row.seal)) throw new Error('verification_state_invalid');
      // Unlike transaction_timestamp(), this is fresh after any lock wait.
      const observed = (await db.query<{ time: Date }>('SELECT clock_timestamp()::TIMESTAMPTZ AS time')).rows[0].time;
      if (session.revoked_at || session.expires_at.getTime() <= observed.getTime() || session.status !== 'active') throw new VerificationFailure('unauthorized', 401);
      const plan = await decide({ principal: { clientId: session.client_id, subjectToken: session.subject_token },
        now: observed.toISOString(), record: row?.state ?? null, current: row?.is_current ?? false, command: commandRow?.command ?? null });
      if (plan.record) {
        const record = plan.record;
        if (record.clientId !== session.client_id || !Number.isSafeInteger(record.version)) throw new Error('verification_owner_invalid');
        if (!row || row.id !== record.id) {
          if (row) {
            const retired = { ...row.state, evidence: {}, pending: null, result: null };
            await db.query('UPDATE identity.identity_verifications SET is_current=false,state=$2,seal=$3,updated_at=now() WHERE id=$1',
              [row.id, JSON.stringify(retired), await this.seal(retired, false)]);
          }
          await db.query(`INSERT INTO identity.identity_verifications (id,client_id,version,state,seal)
            VALUES ($1,$2,$3,$4,$5)`, [record.id, record.clientId, record.version, JSON.stringify(record), await this.seal(record, true)]);
        } else {
          await db.query(`UPDATE identity.identity_verifications SET version=$2,state=$3,seal=$4,updated_at=now()
            WHERE id=$1 AND client_id=$5`, [record.id, record.version, JSON.stringify(record), await this.seal(record, row.is_current), session.client_id]);
        }
      }
      if (plan.command) {
        const command = plan.command;
        if (!input.command || command.key !== input.command.key || command.requestHash !== input.command.requestHash) throw new Error('verification_command_invalid');
        await db.query(`INSERT INTO identity.identity_verification_commands (client_id,idempotency_key,case_id,command,seal)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT (client_id,idempotency_key) DO UPDATE
          SET command=excluded.command,seal=excluded.seal,updated_at=now()`,
        [session.client_id, command.key, command.caseId, JSON.stringify(command),
          await this.integrity.seal(canonicalVerificationContent({ clientId: session.client_id, command }))]);
      }
      if (plan.event) {
        const caseId = plan.record?.id ?? row?.id;
        if (!caseId) throw new Error('verification_capture_missing');
        await db.query(`INSERT INTO identity.audit_events
          (actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
          VALUES ($1,$2,'identity_verification',$3,$4,$5,now()+INTERVAL '90 days')`,
        [session.subject_token, `identity_verification.${plan.event.action}`, caseId, plan.event.capture.outcome, input.traceId]);
        await db.query(`INSERT INTO identity.outbox_events
          (event_id,aggregate_type,aggregate_id,event_type,event_version,payload,correlation_id)
          VALUES ($1,'identity_verification',$2,$3,1,$4,$5)`,
        [crypto.randomUUID(), caseId, `identity.verification_${plan.event.action}`, JSON.stringify({ caseId, capture: plan.event.capture }), input.traceId]);
      }
      await db.query('COMMIT');
      return plan.value;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { await db.end().catch(() => {}); }
  }

  private seal(state: VerificationState, current: boolean) {
    return this.integrity.seal(canonicalVerificationContent({ state, current }));
  }
}
