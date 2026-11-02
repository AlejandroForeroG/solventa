import type { VerifiedIdentity } from './authentication';
import type { Integrity, Platform } from './ports/consents';
import type { IdentityVerificationProvider, VerificationAction, VerificationCapture, VerificationCommand, VerificationContext, VerificationCorpus, VerificationOperation, VerificationStore } from './ports/identity-verification';
import { canonicalVerificationContent, currentVerificationStatus, retainedVerificationInputs, verificationCorpusVersion, VerificationFailure, verificationOutcome, verificationPurpose, verificationSteps, verificationTextVersion, verificationValidityMs, verificationView, verificationWording } from '../domain/identity-verification';
import type { VerificationEvaluation, VerificationEvidence, VerificationLocale, VerificationState, VerificationStep, VerificationView } from '../domain/identity-verification';

type Context = { identity: VerifiedIdentity; traceId: string; caseId: string; key: string };
type Dependencies = { store: VerificationStore; provider: IdentityVerificationProvider; corpus: VerificationCorpus; integrity: Integrity; platform: Platform };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class IdentityVerifications {
  constructor(private readonly deps: Dependencies) {}

  async terms(locale: VerificationLocale) {
    const wording = verificationWording[locale];
    const wordingHash = await this.deps.integrity.digest(canonicalVerificationContent({ purpose: verificationPurpose,
      textVersion: verificationTextVersion, locale, wording, validityHours: 24, corpusVersion: verificationCorpusVersion }));
    return { purpose: verificationPurpose, textVersion: verificationTextVersion, locale, wording, wordingHash,
      validityHours: 24, corpusVersion: verificationCorpusVersion, simulated: true as const };
  }
  fixtures() { return this.deps.corpus.list(); }

  inspect(identity: VerifiedIdentity, traceId: string) {
    return this.deps.store.execute({ identity, traceId }, async ctx => {
      const state = ctx.record;
      if (!state) return { value: null };
      if (currentVerificationStatus(state, ctx.now) === 'expired' && state.status !== 'expired') {
        const expired: VerificationState = { ...state, version: state.version + 1, status: 'expired', evidence: {}, pending: null, result: null };
        return { value: verificationView(expired, ctx.now), record: expired,
          event: this.event(expired, traceId, ctx.now, 'expired', {}, []) };
      }
      return { value: verificationView(state, ctx.now) };
    });
  }

  async grant(input: Omit<Context, 'caseId'>, body: { textVersion: number; locale: VerificationLocale }) {
    const operation = await this.operation('grant', { ...input, caseId: '' }, body);
    const terms = await this.terms(body.locale);
    return this.deps.store.execute(operation, async ctx => {
      if (this.replayed(ctx, operation)) return { value: verificationView(this.owned(ctx), ctx.now) };
      if (body.textVersion !== verificationTextVersion) throw new VerificationFailure('terms_outdated', 409);
      if (ctx.record && !['expired', 'revoked'].includes(currentVerificationStatus(ctx.record, ctx.now))) throw new VerificationFailure('conflict', 409);
      const record: VerificationState = {
        id: this.deps.platform.newId(), clientId: ctx.principal.clientId, version: 1,
        createdAt: ctx.now, expiresAt: new Date(Date.parse(ctx.now) + verificationValidityMs).toISOString(), revokedAt: null,
        consentId: this.deps.platform.newId(), textVersion: terms.textVersion, locale: terms.locale, wordingHash: terms.wordingHash,
        evidence: {}, status: 'draft', failures: 0, pending: null, result: null, assistance: null,
      };
      return { value: verificationView(record, ctx.now), record, command: this.command(operation, record),
        event: this.event(record, input.traceId, ctx.now, 'consent_granted', { locale: body.locale, textVersion: body.textVersion, wordingHash: terms.wordingHash }, []) };
    });
  }

  async saveStep(input: Context, step: VerificationStep, evidence: VerificationEvidence, expectedVersion: number) {
    const operation = await this.operation('step', input, { step, evidence, expectedVersion });
    if (!verificationSteps.includes(step) || !this.deps.corpus.accepts(step, evidence)) throw new VerificationFailure('evidence_invalid', 400);
    return this.deps.store.execute(operation, async ctx => {
      const state = this.owned(ctx);
      if (this.replayed(ctx, operation)) return { value: verificationView(state, ctx.now) };
      this.mutable(ctx, state, expectedVersion);
      const record: VerificationState = { ...state, version: state.version + 1, evidence: { ...state.evidence, [step]: { ...evidence } }, result: null, status: 'draft' };
      return { value: verificationView(record, ctx.now), record, command: this.command(operation, record),
        event: this.event(record, input.traceId, ctx.now, 'step_saved', { step, ...evidence, expectedVersion }, [evidence.corpusVersion]) };
    });
  }

  async evaluate(input: Context, expectedVersion: number): Promise<VerificationView> {
    const operation = await this.operation('evaluate', input, { expectedVersion });
    type Prepared = { done: true; view: VerificationView } | { done: false; record: VerificationState; pending: NonNullable<VerificationState['pending']> };
    const prepared = await this.deps.store.execute<Prepared>(operation, async ctx => {
      const state = this.owned(ctx);
      if (this.replayed(ctx, operation)) {
        if (ctx.command?.phase === 'completed') return { value: { done: true, view: verificationView(state, ctx.now) } };
        this.active(ctx, state);
        if (!state.pending || state.pending.key !== input.key || state.pending.evaluationId !== ctx.command?.evaluationId) throw new VerificationFailure('conflict', 409);
        return { value: { done: false, record: state, pending: state.pending } };
      }
      this.mutable(ctx, state, expectedVersion);
      const { document, selfie, liveness } = state.evidence;
      if (!document || !selfie || !liveness) throw new VerificationFailure('steps_incomplete', 409);
      const evidence = { document, selfie, liveness };
      if (verificationSteps.some(step => !this.deps.corpus.accepts(step, evidence[step]))) throw new VerificationFailure('evidence_invalid', 409);
      const pending = { evaluationId: this.deps.platform.newId(), key: input.key, expectedVersion, startedAt: ctx.now, evidence };
      const record: VerificationState = { ...state, version: state.version + 1, status: 'processing', pending, result: null };
      return { value: { done: false, record, pending }, record,
        command: { ...this.command(operation, record), phase: 'processing', evaluationId: pending.evaluationId },
        event: this.event(record, input.traceId, ctx.now, 'evaluation_requested', { evaluationId: pending.evaluationId, evidence, expectedVersion }, [verificationCorpusVersion]) };
    });
    if (prepared.done) return prepared.view;
    let evaluation: VerificationEvaluation | null = null;
    try {
      evaluation = await this.deps.provider.evaluate({ evaluationId: prepared.pending.evaluationId,
        evidence: prepared.pending.evidence, requestedAt: prepared.pending.startedAt });
    } catch { /* A technical failure is persisted below without invalidating evidence. */ }
    return this.deps.store.execute(operation, async ctx => {
      const state = this.owned(ctx);
      if (!this.replayed(ctx, operation)) throw new VerificationFailure('conflict', 409);
      if (ctx.command?.phase === 'completed') return { value: verificationView(state, ctx.now) };
      this.active(ctx, state);
      if (!state.pending || state.pending.evaluationId !== prepared.pending.evaluationId || state.pending.key !== input.key) throw new VerificationFailure('conflict', 409);
      const result = evaluation?.evaluationId === state.pending.evaluationId && evaluation.simulated === true
        && Date.parse(evaluation.completedAt) >= Date.parse(state.pending.startedAt) && Date.parse(evaluation.completedAt) <= Date.parse(ctx.now) ? evaluation : null;
      const outcome = result ? verificationOutcome(result) : 'unavailable';
      const record: VerificationState = { ...state, version: state.version + 1, pending: null, result, status: outcome,
        evidence: result ? retainedVerificationInputs(state.pending.evidence, result) : state.pending.evidence,
        failures: state.failures + (outcome === 'approved' ? 0 : 1) };
      return { value: verificationView(record, ctx.now), record, command: { ...ctx.command!, phase: 'completed' },
        event: this.event(record, input.traceId, ctx.now, 'evaluated', { evaluationId: prepared.pending.evaluationId,
          evidence: prepared.pending.evidence, result }, result ? [result.providerVersion] : []) };
    });
  }

  async requestAssistance(input: Context, expectedVersion: number) {
    const operation = await this.operation('assistance', input, { expectedVersion });
    return this.deps.store.execute(operation, async ctx => {
      const state = this.owned(ctx);
      if (this.replayed(ctx, operation)) return { value: verificationView(state, ctx.now) };
      this.active(ctx, state);
      if (state.assistance) return { value: verificationView(state, ctx.now), command: this.command(operation, state) };
      this.mutable(ctx, state, expectedVersion);
      if (state.failures < 1) throw new VerificationFailure('assistance_unavailable', 409);
      const record: VerificationState = { ...state, version: state.version + 1,
        assistance: { reference: this.deps.platform.newId(), status: 'pending', requestedAt: ctx.now } };
      return { value: verificationView(record, ctx.now), record, command: this.command(operation, record),
        event: this.event(record, input.traceId, ctx.now, 'assistance_requested', { reference: record.assistance!.reference, expectedVersion }, []) };
    });
  }

  async revoke(input: Context) {
    const operation = await this.operation('revoke', input, {});
    return this.deps.store.execute(operation, async ctx => {
      const state = this.owned(ctx);
      if (this.replayed(ctx, operation)) return { value: verificationView(state, ctx.now) };
      if (state.revokedAt) return { value: verificationView(state, ctx.now), command: this.command(operation, state) };
      const record: VerificationState = { ...state, version: state.version + 1, revokedAt: ctx.now,
        status: 'revoked', evidence: {}, pending: null, result: null };
      return { value: verificationView(record, ctx.now), record, command: this.command(operation, record),
        event: this.event(record, input.traceId, ctx.now, 'consent_revoked', {}, []) };
    });
  }

  private async operation(action: VerificationAction, input: Context, body: unknown): Promise<VerificationOperation> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.key) || (input.caseId && !uuid.test(input.caseId))) throw new VerificationFailure('invalid_request', 400);
    return { identity: input.identity, traceId: input.traceId, ...(input.caseId ? { caseId: input.caseId } : {}),
      command: { key: input.key, action, requestHash: await this.deps.integrity.digest(canonicalVerificationContent({ action, caseId: input.caseId, body })) } };
  }
  private owned(ctx: VerificationContext): VerificationState {
    if (!ctx.record) throw new VerificationFailure('not_found', 404);
    return ctx.record;
  }
  private replayed(ctx: VerificationContext, operation: VerificationOperation) {
    if (!ctx.command) return false;
    if (ctx.command.requestHash !== operation.command?.requestHash || ctx.command.action !== operation.command.action) throw new VerificationFailure('conflict', 409);
    return true;
  }
  private active(ctx: VerificationContext, state: VerificationState) {
    if (!ctx.current || ['revoked', 'expired'].includes(currentVerificationStatus(state, ctx.now))) throw new VerificationFailure('consent_inactive', 409);
  }
  private mutable(ctx: VerificationContext, state: VerificationState, expectedVersion: number) {
    this.active(ctx, state);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new VerificationFailure('invalid_request', 400);
    if (state.version !== expectedVersion) throw new VerificationFailure('conflict', 409);
    if (state.pending) throw new VerificationFailure('verification_in_progress', 409);
    if (state.status === 'approved') throw new VerificationFailure('conflict', 409);
  }
  private command(operation: VerificationOperation, state: VerificationState): VerificationCommand {
    if (!operation.command) throw new Error('verification_command_missing');
    return { ...operation.command, caseId: state.id, phase: 'completed' };
  }
  private event(state: VerificationState, traceId: string, now: string, action: string, inputs: Record<string, unknown>, sources: string[]) {
    const active = !['revoked', 'expired'].includes(currentVerificationStatus(state, now));
    const capture: VerificationCapture = { schemaVersion: 1, contractVersion: 'v1', correlationId: traceId,
      inputs: { caseId: state.id, ...inputs }, sources: sources.map(source => ({ source, capturedAt: now, quality: 'synthetic' })),
      consent: active ? { status: 'verified', id: state.consentId, version: state.textVersion } : { status: 'absent' },
      rule: { id: 'synthetic-identity-verification', version: '1' }, outcome: state.status };
    return { action, capture };
  }
}
