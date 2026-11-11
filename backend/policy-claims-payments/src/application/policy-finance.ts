import { MAX_LISTED_POLICIES, canonical, eventContent, eventWithinIssuedCoverage, FINANCIAL_RULE, HEX, InvalidFinancialRecord, isAcceptedOffer, isOfferEnvelope, isParametricEnvelope, issuanceTimeContent, iso, offerContent, paymentContent, policyDocument, UUID } from '../domain/financial';
import type { FinancialActor, FinancialErrorCode, FinancialResult, PaymentView, PolicyListResult, PolicySummary, PolicyView } from '../domain/financial';
import { indemnityAmount, occurrenceCovered, occurrenceEvidence } from '../domain/parametric';
import type { ParametricOccurrence, ParametricResult } from '../domain/parametric';
import { documentFile, policyDetail } from '../domain/policy-portal';
import type { IssuedPolicyFacts, PolicyDetailResult, PolicyDocumentKind, PolicyDocumentResult } from '../domain/policy-portal';
import type { FinancialDependencies, FinancialTransaction, IndemnityCandidate, IssuanceCandidate, Payment, PolicyRecord, StoredPolicy } from './ports/financial';
import { financialDecision, financialEventSource, financialRejection, gatewaySource, providerEventSource } from './financial-decision';
import type { FinancialAction, FinancialEvidence, FinancialSource } from './financial-decision';

import { isLifecycleChange, lifecycleContent } from '../domain/policy-lifecycle';
import type { LifecycleAction, LifecycleChange } from '../domain/policy-lifecycle';
import { ADVISOR_AUTHORIZATION_RULE, advisorAuthorizationContent, advisorAuthorizationView, isAdvisorAuthorization } from '../domain/advisor-authorization';
import type { AdvisorApprovalResult, AdvisorAuthorization, AdvisorAuthorizationRecord, AdvisorAuthorizationsResult, AdvisorIdentity, AdvisorLifecycleResult, AdvisorTarget, DelegatedLifecycleExecution } from '../domain/advisor-authorization';

class Rejection extends Error {
  constructor(readonly code: FinancialErrorCode, readonly httpStatus: 400 | 403 | 404 | 409 = 409) { super(code); }
}
const reject = (code: FinancialErrorCode, httpStatus: 400 | 403 | 404 | 409 = 409): never => { throw new Rejection(code, httpStatus); };
const view = (policy: StoredPolicy): PolicyView => ({ ...(policy.lifecycle ? { lifecycle: policy.lifecycle } : {}), policyId: policy.id, offerId: policy.offerId, offerVersion: policy.offerVersion,
  status: policy.status, premium: policy.premium, currency: 'COP', effectiveFrom: policy.effectiveFrom,
  effectiveUntil: policy.effectiveUntil, document: policy.document, documentHash: policy.documentHash, synthetic: true, providerMode: 'mock' });
const summary = (policy: StoredPolicy): PolicySummary => {
  if (policy.status !== 'issued') throw new InvalidFinancialRecord();
  return { ...(policy.lifecycle ? { contractStatus: policy.lifecycle.action } : {}), policyId: policy.id, product: policy.offer.product, status: 'issued', premium: policy.premium, currency: 'COP',
    effectiveFrom: policy.effectiveFrom, effectiveUntil: policy.effectiveUntil, coverage: policy.offer.coverage };
};
// Only a provider-acknowledged premium exposes its synthetic receipt reference.
const paid = (premium: Payment | null): { payment?: PaymentView } => premium ? { payment: { status: premium.status,
  reference: premium.status === 'confirmed' || premium.status === 'refunded' ? premium.providerReference : null } } : {};
const validActor = (actor: FinancialActor) => UUID.test(actor.clientId) && UUID.test(actor.subjectToken);
const historicalView = (value: PolicyView) => { const { lifecycle: _lifecycle, ...issued } = value; return canonical(issued); };
type IssuanceContext = { actor: FinancialActor; policyId: string; documentHash: string; commandKey: string; traceId: string; trigger?: 'reconciliation' };
export type IndemnityOutcome = { traceId: string; outcome: 'confirmed' | 'unchanged' | 'rejected' | 'unavailable'; error?: FinancialErrorCode };
export type ReconciliationOutcome = { traceId: string; outcome: 'issued' | 'refunded' | 'unchanged' | 'rejected' | 'unavailable'; error?: FinancialErrorCode };
type LifecycleInput = { actor: FinancialActor; policyId: string; action: LifecycleAction; replacementPolicyId: string | null;
  documentHash: string; reason: string; idempotencyKey: string; traceId: string };
type DelegationContext = { identity: AdvisorIdentity; authorization: AdvisorAuthorization };

export class PolicyFinance {
  constructor(private readonly deps: FinancialDependencies) {}

  private async run<T>(trace: string, operation: (traceId: string) => Promise<T | Extract<FinancialResult, { status: 'denied' | 'unavailable' }>>): Promise<T | Extract<FinancialResult, { status: 'denied' | 'unavailable' }>> {
    const traceId = UUID.test(trace) ? trace : this.deps.newId();
    if (!this.deps.enabled) return { status: 'unavailable', error: 'financial_unavailable', httpStatus: 503, traceId };
    try { return await operation(traceId); }
    catch (caught) {
      const error = caught instanceof InvalidFinancialRecord ? new Rejection('integrity_violation') : caught;
      if (error instanceof Rejection) {
        try {
          const id = this.deps.newId();
          await this.deps.store.rejection(id, traceId, error.code, financialRejection(id, traceId, error.code));
          return { status: 'denied', error: error.code, httpStatus: error.httpStatus, traceId };
        } catch { /* A rejection without its required audit must not claim durable completion. */ }
      }
      return { status: 'unavailable', error: 'financial_unavailable', httpStatus: 503, traceId };
    }
  }

  private decision(action: Exclude<FinancialAction, 'financial.denied'>, traceId: string, policy: StoredPolicy, outcome: string, evidence: FinancialEvidence = {}) {
    return financialDecision(action, traceId, policy, outcome, this.deps.now().toISOString(), evidence);
  }

  private async checked(record: PolicyRecord | null, actor?: FinancialActor): Promise<PolicyRecord> {
    if (!record) return reject('not_found', 404);
    const { policy, premium, signature } = record;
    if (policy.lifecycle && (!isLifecycleChange(policy.lifecycle) || policy.lifecycle.policyId !== policy.id
      || policy.lifecycle.sourceDocumentHash !== policy.documentHash || !await this.deps.integrity.verify(lifecycleContent(policy.lifecycle), policy.lifecycle.documentHash))) return reject('integrity_violation');
    if (actor && (policy.clientId !== actor.clientId || policy.subjectToken !== actor.subjectToken)) return reject('not_found', 404);
    const offer = policy.offer;
    if (!isAcceptedOffer(offer) || !(await this.deps.integrity.verify(offerContent(offer), policy.termsHash))
      || policy.clientId !== offer.clientId || policy.subjectToken !== offer.subjectToken || policy.offerId !== offer.offerId
      || policy.offerVersion !== offer.offerVersion || policy.premium !== offer.premium || policy.currency !== offer.currency
      || canonical(policy.coverageSnapshot) !== canonical(offer.coverage)
      || Date.parse(policy.effectiveFrom) !== Date.parse(offer.effectiveFrom) || Date.parse(policy.effectiveUntil) !== Date.parse(offer.effectiveUntil)
      || policy.document !== policyDocument(policy.id, offer) || !(await this.deps.integrity.verify(policy.document, policy.documentHash))) return reject('integrity_violation');
    if (premium) await this.checkPayment(premium, policy);
    if ((policy.status === 'pending' && premium && !['pending', 'declined'].includes(premium.status))
      || (['charged', 'refunding', 'issued'].includes(policy.status) && premium?.status !== 'confirmed')
      || (policy.status === 'refunded' && premium?.status !== 'refunded')) return reject('integrity_violation');
    if (policy.status !== 'issued' && signature) return reject('integrity_violation');
    if (policy.status === 'issued') {
      if (!signature || signature.documentHash !== policy.documentHash
        || !(await this.deps.integrity.verify(JSON.stringify(['mock-signature-v1', policy.id, policy.documentHash]), signature.receipt))
        || !iso(signature.signedAt) || Date.parse(signature.signedAt) >= Date.parse(offer.expiresAt)
        || !signature.timeSeal || !eventWithinIssuedCoverage(signature.signedAt, signature.signedAt, policy.effectiveFrom, policy.effectiveUntil)
        || !(await this.deps.integrity.verify(issuanceTimeContent(policy.id, policy.documentHash, signature.signedAt), signature.timeSeal))
        || !premium || premium.status !== 'confirmed') return reject('integrity_violation');
    }
    return record;
  }

  acceptOffer(input: unknown, trace: string): Promise<FinancialResult> {
    return this.run(trace, async traceId => {
      if (!isOfferEnvelope(input, this.deps.environment) || Date.parse(input.occurredAt) > this.deps.now().getTime() + 60000
        || !(await this.deps.integrity.verify(eventContent(input), input.signature))) return reject('invalid_event', 400);
      const hash = await this.deps.integrity.digest(eventContent(input));
      const termsHash = await this.deps.integrity.digest(offerContent(input.payload));
      const id = this.deps.newId();
      const document = policyDocument(id, input.payload);
      const documentHash = await this.deps.integrity.digest(document);
      const source = financialEventSource(input, this.deps.now().toISOString());
      const offer = input.payload;
      const policy: StoredPolicy = { id, clientId: offer.clientId, subjectToken: offer.subjectToken, status: 'pending',
        offer, termsHash, document, documentHash, premium: offer.premium, currency: offer.currency,
        offerId: offer.offerId, offerVersion: offer.offerVersion, effectiveFrom: offer.effectiveFrom, effectiveUntil: offer.effectiveUntil, coverageSnapshot: offer.coverage };
      const capture = this.decision('offer.accepted', traceId, policy, 'accepted', { sources: [source],
        event: { eventId: input.eventId, eventType: input.eventType, environment: input.environment, occurredAt: input.occurredAt } });
      const imported = await this.deps.store.importAcceptance(policy,
        { eventId: input.eventId, consumer: 'policy.offer-accepted.v1', eventType: input.eventType, hash }, traceId, capture);
      if (imported.status === 'created') return { status: 'ok', replayed: false, policy: view(policy) };
      const { inbox } = imported.snapshot;
      if (!inbox || inbox.hash !== hash || !inbox.policyId || inbox.outcome !== 'accepted') return reject('event_conflict');
      const replayPolicyId = inbox.policyId;
      return this.deps.store.transaction(async tx => {
        const { policy: existing } = await this.checked(await tx.policy(replayPolicyId));
        return { status: 'ok', replayed: true, policy: view(existing) };
      });
    });
  }

  get(input: { actor: FinancialActor; policyId: string; traceId: string }): Promise<FinancialResult> {
    return this.run(input.traceId, async traceId => {
      if (!validActor(input.actor) || !UUID.test(input.policyId)) return reject('invalid_request', 400);
      const { policy, premium } = await this.checked(await this.deps.store.readPolicy(input.policyId, input.actor), input.actor);
      return { status: 'ok', replayed: false, policy: view(policy), ...paid(premium) };
    });
  }

  changeLifecycle(input: LifecycleInput): Promise<FinancialResult> {
    return this.run(input.traceId, async traceId => {
      return this.deps.store.transaction(tx => this.applyLifecycle(tx, input, traceId));
    });
  }

  private async applyLifecycle(tx: FinancialTransaction, input: LifecycleInput, traceId: string, delegated?: DelegationContext): Promise<FinancialResult> {
        if (!validActor(input.actor) || !UUID.test(input.policyId) || !HEX.test(input.documentHash)
          || !['modified', 'renewed', 'cancelled'].includes(input.action) || !/^[a-z][a-z_]{2,63}$/.test(input.reason)
          || !/^[\x21-\x7e]{1,128}$/.test(input.idempotencyKey)
          || (input.action === 'cancelled' ? input.replacementPolicyId !== null : !input.replacementPolicyId || !UUID.test(input.replacementPolicyId))) return reject('invalid_request', 400);
        const executorId = delegated?.identity.clientId ?? input.actor.clientId;
        const key = await this.deps.integrity.digest(JSON.stringify([delegated ? 'lifecycle-key-v2' : 'lifecycle-key-v1', executorId, input.idempotencyKey]));
        const hash = await this.deps.integrity.digest(JSON.stringify(delegated
          ? ['lifecycle-request-v2', delegated.authorization.id, input.actor.clientId, input.policyId, input.action, input.replacementPolicyId, input.documentHash, input.reason]
          : ['lifecycle-request-v1', input.policyId, input.action, input.replacementPolicyId, input.documentHash, input.reason]));
        if (!tx.lifecycleCommand || !tx.lifecycleReplacement || !tx.saveLifecycle) throw Error('lifecycle_not_configured');
        // Lock both owned policies in deterministic order; a payment or another lifecycle command shares these locks.
        const records = new Map<string, PolicyRecord>();
        for (const id of [...new Set([input.policyId, ...(input.replacementPolicyId ? [input.replacementPolicyId] : [])])].sort()) {
          records.set(id, await this.checked(await tx.policy(id, input.actor), input.actor));
        }
        const source = records.get(input.policyId);
        if (!source) throw Error('lifecycle_source_missing');
        if (delegated) {
          const refreshed = await this.checkedAdvisorAuthorization(await tx.advisorAuthorization?.(delegated.authorization.id, delegated.identity, 'advisor'));
          this.requireAdvisorPermission(delegated.identity);
          if (refreshed.revokedAt || Date.parse(refreshed.authorization.expiresAt) <= this.deps.now().getTime()
            || refreshed.authorization.seal !== delegated.authorization.seal
            || canonical(refreshed.authorization.owner) !== canonical(input.actor)
            || refreshed.authorization.advisor.clientId !== delegated.identity.clientId
            || refreshed.authorization.advisor.subjectToken !== delegated.identity.subjectToken
            || refreshed.authorization.advisorReference !== delegated.identity.advisorReference) return reject('not_found', 404);
        }
        const { policy } = source;
        if (policy.documentHash !== input.documentHash) return reject('document_mismatch');
        const prior = await tx.lifecycleCommand(executorId, key);
        if (prior && (prior.policyId !== policy.id || prior.requestHash !== hash)) return reject('idempotency_conflict');
        if (prior && policy.lifecycle) return { status: 'ok', replayed: true, policy: view(policy), ...paid(source.premium) };
        if (policy.status !== 'issued' || policy.lifecycle || !source.signature) return reject('policy_not_active');
        const now = this.deps.now();
        const replacement = input.replacementPolicyId ? records.get(input.replacementPolicyId) : undefined;
        if (delegated && (replacement?.policy.documentHash ?? null) !== delegated.authorization.replacementDocumentHash) return reject('document_mismatch');
        if (input.action !== 'cancelled') {
          if (input.replacementPolicyId && await tx.lifecycleReplacement(input.replacementPolicyId)) return reject('policy_not_active');
          if (!replacement || !replacement.signature || replacement.policy.status !== 'issued' || replacement.policy.lifecycle
            || replacement.policy.id === policy.id || replacement.policy.offer.product !== policy.offer.product
            || Date.parse(replacement.signature.signedAt) < Date.parse(source.signature.signedAt)
            || Date.parse(replacement.policy.effectiveFrom) > now.getTime()
            || Date.parse(replacement.policy.effectiveUntil) <= now.getTime()) return reject('policy_not_active');
          if (input.action === 'renewed' && (now.getTime() < Date.parse(policy.effectiveUntil)
            || Date.parse(replacement.policy.effectiveFrom) < Date.parse(policy.effectiveUntil))) return reject('invalid_request', 400);
        }
        if (input.action === 'modified' && now.getTime() >= Date.parse(policy.effectiveUntil)) return reject('policy_not_active');
        const change: LifecycleChange = { changeId: this.deps.newId(), policyId: policy.id, action: input.action,
          reason: input.reason, at: now.toISOString(), replacementPolicyId: input.replacementPolicyId,
          sourceDocumentHash: policy.documentHash, replacementDocumentHash: replacement?.policy.documentHash ?? null,
          refund: 'not_automated', ruleVersion: 'academic-policy-lifecycle-1', documentHash: '' };
        change.documentHash = await this.deps.integrity.digest(lifecycleContent(change));
        const capture = this.decision('policy.lifecycle.changed', traceId, policy, input.action, { payment: source.premium ?? undefined });
        capture.rule.version = change.ruleVersion;
        capture.inputs.lifecycle = change;
        const execution: DelegatedLifecycleExecution | undefined = delegated ? { authorizationId: delegated.authorization.id,
          ownerClientId: delegated.authorization.owner.clientId, advisorClientId: delegated.identity.clientId,
          advisorReference: delegated.authorization.advisorReference, grantedAt: delegated.authorization.grantedAt,
          expiresAt: delegated.authorization.expiresAt, authorizationExpiresAt: delegated.identity.authorizationExpiresAt,
          authorizationSeal: delegated.authorization.seal } : undefined;
        if (execution) capture.inputs.authorization = execution;
        await tx.saveLifecycle(change, executorId, key, hash, capture, traceId, execution);
        if (delegated) {
          this.requireAdvisorPermission(delegated.identity);
          if (Date.parse(delegated.authorization.expiresAt) <= this.deps.now().getTime()) throw Error('advisor_approval_expired');
        }
        return { status: 'ok', replayed: false, policy: view({ ...policy, lifecycle: change }), ...paid(source.premium) };
  }

  private requireAdvisorPermission(identity: AdvisorIdentity) {
    const expires = Date.parse(identity.authorizationExpiresAt), now = this.deps.now().getTime();
    if (!validActor(identity) || !UUID.test(identity.advisorReference) || !iso(identity.authorizationExpiresAt)
      || !(expires > now) || expires > now + 5500) throw Error('advisor_access_expired');
  }

  private async checkedAdvisorAuthorization(record: AdvisorAuthorizationRecord | null | undefined): Promise<AdvisorAuthorizationRecord> {
    if (!record) return reject('not_found', 404);
    if (!isAdvisorAuthorization(record.authorization) || (record.revokedAt !== null && !iso(record.revokedAt))
      || (record.changeId !== null && !UUID.test(record.changeId))
      || !await this.deps.integrity.verify(advisorAuthorizationContent(record.authorization), record.authorization.seal)) return reject('integrity_violation');
    return record;
  }

  createAdvisorAuthorization(input: { actor: FinancialActor; advisor: AdvisorTarget; policyId: string; action: LifecycleAction;
    replacementPolicyId: string | null; documentHash: string; expiresAt: string; idempotencyKey: string; traceId: string }): Promise<AdvisorApprovalResult> {
    return this.run<AdvisorApprovalResult>(input.traceId, async traceId => {
      const now = this.deps.now();
      if (!validActor(input.actor) || !validActor(input.advisor.principal) || input.actor.clientId === input.advisor.principal.clientId
        || !UUID.test(input.advisor.reference) || !UUID.test(input.policyId) || !HEX.test(input.documentHash)
        || !['modified', 'renewed', 'cancelled'].includes(input.action) || !iso(input.expiresAt)
        || Date.parse(input.expiresAt) <= now.getTime() || Date.parse(input.expiresAt) > now.getTime() + 7 * 86400000
        || !/^[\x21-\x7e]{1,128}$/.test(input.idempotencyKey)
        || (input.action === 'cancelled' ? input.replacementPolicyId !== null : !input.replacementPolicyId || !UUID.test(input.replacementPolicyId))) return reject('invalid_request', 400);
      const key = await this.deps.integrity.digest(JSON.stringify(['advisor-approval-key-v1', input.actor.clientId, input.idempotencyKey]));
      const requestHash = await this.deps.integrity.digest(JSON.stringify(['advisor-approval-request-v1', input.policyId, input.advisor.reference,
        input.action, input.replacementPolicyId, input.documentHash, input.expiresAt]));
      return this.deps.store.transaction(async tx => {
        if (!tx.advisorAuthorizationCommand || !tx.saveAdvisorAuthorization) throw Error('advisor_approval_unavailable');
        const records = new Map<string, PolicyRecord>();
        for (const id of [...new Set([input.policyId, ...(input.replacementPolicyId ? [input.replacementPolicyId] : [])])].sort()) {
          records.set(id, await this.checked(await tx.policy(id, input.actor), input.actor));
        }
        const prior = await tx.advisorAuthorizationCommand(input.actor, key);
        if (prior) {
          const record = await this.checkedAdvisorAuthorization(prior.record);
          if (prior.requestHash !== requestHash) return reject('idempotency_conflict');
          return { status: 'ok', authorization: advisorAuthorizationView(record, this.deps.now().getTime()), replayed: true };
        }
        const source = records.get(input.policyId), replacement = input.replacementPolicyId ? records.get(input.replacementPolicyId) : null;
        if (!source || source.policy.status !== 'issued' || source.policy.lifecycle || !source.signature) return reject('policy_not_active');
        if (source.policy.documentHash !== input.documentHash) return reject('document_mismatch');
        if (input.action !== 'cancelled' && (!replacement || replacement.policy.status !== 'issued' || replacement.policy.lifecycle || !replacement.signature
          || replacement.policy.id === source.policy.id || replacement.policy.offer.product !== source.policy.offer.product)) return reject('policy_not_active');
        const grantedAt = this.deps.now().toISOString();
        if (Date.parse(input.expiresAt) <= Date.parse(grantedAt)) return reject('invalid_request', 400);
        const value: AdvisorAuthorization = { id: this.deps.newId(), policyId: input.policyId, owner: { clientId: input.actor.clientId, subjectToken: input.actor.subjectToken },
          advisor: { clientId: input.advisor.principal.clientId, subjectToken: input.advisor.principal.subjectToken }, advisorReference: input.advisor.reference, action: input.action,
          documentHash: input.documentHash, replacementPolicyId: input.replacementPolicyId, replacementDocumentHash: replacement?.policy.documentHash ?? null,
          grantedAt, expiresAt: new Date(input.expiresAt).toISOString(), ruleVersion: ADVISOR_AUTHORIZATION_RULE, seal: '' };
        value.seal = await this.deps.integrity.digest(advisorAuthorizationContent(value));
        const capture = this.decision('policy.advisor.authorization.granted', traceId, source.policy, 'granted');
        capture.rule.version = ADVISOR_AUTHORIZATION_RULE; capture.inputs.resourceId = value.id; capture.inputs.policyId = value.policyId; capture.inputs.authorization = value;
        if (!(Date.parse(input.advisor.expiresAt) > this.deps.now().getTime()) || Date.parse(input.advisor.expiresAt) > this.deps.now().getTime() + 5500) throw Error('advisor_eligibility_expired');
        await tx.saveAdvisorAuthorization(value, key, requestHash, capture, traceId);
        if (!(Date.parse(input.advisor.expiresAt) > this.deps.now().getTime())) throw Error('advisor_eligibility_expired');
        return { status: 'ok', authorization: advisorAuthorizationView({ authorization: value, revokedAt: null, changeId: null }, this.deps.now().getTime()), replayed: false };
      });
    });
  }

  private approvalCursor(after?:string) {
    if(after===undefined)return undefined;
    const parts=after.split('|');
    if(parts.length!==2||!iso(parts[0])||!UUID.test(parts[1]))return reject('invalid_request',400);
    return{grantedAt:parts[0],id:parts[1]};
  }

  listAdvisorAuthorizations(input: { actor: FinancialActor; policyId: string; traceId: string; after?:string }): Promise<AdvisorAuthorizationsResult> {
    return this.run<AdvisorAuthorizationsResult>(input.traceId, async () => {
      if (!validActor(input.actor) || !UUID.test(input.policyId)) return reject('invalid_request', 400);
      const after=this.approvalCursor(input.after);
      return this.deps.store.transaction(async tx => {
        await this.checked(await tx.policy(input.policyId, input.actor), input.actor);
        if (!tx.listAdvisorAuthorizations) throw Error('advisor_approval_unavailable');
        const records = await tx.listAdvisorAuthorizations(input.actor, 'owner', input.policyId, 21, undefined, after);
        const checked = await Promise.all(records.slice(0, 20).map(record => this.checkedAdvisorAuthorization(record)));
        return { status: 'ok', authorizations: checked.map(record => advisorAuthorizationView(record, this.deps.now().getTime())), hasMore: records.length > 20, nextCursor: records.length > 20 ? checked[19].authorization.grantedAt+'|'+checked[19].authorization.id : null };
      });
    });
  }

  revokeAdvisorAuthorization(input: { actor: FinancialActor; policyId: string; authorizationId: string; traceId: string }): Promise<AdvisorApprovalResult> {
    return this.run<AdvisorApprovalResult>(input.traceId, async traceId => {
      if (!validActor(input.actor) || !UUID.test(input.policyId) || !UUID.test(input.authorizationId)) return reject('invalid_request', 400);
      return this.deps.store.transaction(async tx => {
        const source = await this.checked(await tx.policy(input.policyId, input.actor), input.actor);
        const record = await this.checkedAdvisorAuthorization(await tx.advisorAuthorization?.(input.authorizationId, input.actor, 'owner'));
        if (record.authorization.policyId !== input.policyId) return reject('not_found', 404);
        if (record.revokedAt) return { status: 'ok', authorization: advisorAuthorizationView(record, this.deps.now().getTime()), replayed: true };
        if (!tx.revokeAdvisorAuthorization) throw Error('advisor_approval_unavailable');
        const at = this.deps.now().toISOString(), capture = this.decision('policy.advisor.authorization.revoked', traceId, source.policy, 'revoked');
        capture.rule.version = ADVISOR_AUTHORIZATION_RULE; capture.inputs.resourceId = record.authorization.id; capture.inputs.policyId = input.policyId;
        capture.inputs.authorizationId = record.authorization.id;
        await tx.revokeAdvisorAuthorization(record.authorization, at, capture, traceId);
        return { status: 'ok', authorization: advisorAuthorizationView({ ...record, revokedAt: at }, this.deps.now().getTime()), replayed: false };
      });
    });
  }

  advisorAuthorizations(input: { actor: AdvisorIdentity; traceId: string; after?:string }): Promise<AdvisorAuthorizationsResult> {
    return this.run<AdvisorAuthorizationsResult>(input.traceId, async () => {
      this.requireAdvisorPermission(input.actor);
      const after=this.approvalCursor(input.after);
      return this.deps.store.transaction(async tx => {
        if (!tx.listAdvisorAuthorizations) throw Error('advisor_approval_unavailable');
        const records = await tx.listAdvisorAuthorizations(input.actor, 'advisor', null, 21, input.actor.advisorReference, after);
        const checked = await Promise.all(records.slice(0, 20).map(record => this.checkedAdvisorAuthorization(record)));
        this.requireAdvisorPermission(input.actor);
        return { status: 'ok', authorizations: checked.map(record => advisorAuthorizationView(record, this.deps.now().getTime())), hasMore: records.length > 20, nextCursor: records.length > 20 ? checked[19].authorization.grantedAt+'|'+checked[19].authorization.id : null };
      });
    });
  }

  async changeAdvisorLifecycle(input: { actor: AdvisorIdentity; authorizationId: string; reason: string; idempotencyKey: string; traceId: string }): Promise<AdvisorLifecycleResult> {
    const result = await this.run(input.traceId, async traceId => {
      this.requireAdvisorPermission(input.actor);
      if (!UUID.test(input.authorizationId)) return reject('invalid_request', 400);
      return this.deps.store.transaction(async tx => {
        const record = await this.checkedAdvisorAuthorization(await tx.advisorAuthorization?.(input.authorizationId, input.actor, 'advisor'));
        const value = record.authorization;
        if (value.advisorReference !== input.actor.advisorReference || record.revokedAt || Date.parse(value.expiresAt) <= this.deps.now().getTime()) return reject('not_found', 404);
        const result = await this.applyLifecycle(tx, { actor: value.owner, policyId: value.policyId, action: value.action,
          replacementPolicyId: value.replacementPolicyId, documentHash: value.documentHash, reason: input.reason,
          idempotencyKey: input.idempotencyKey, traceId }, traceId, { identity: input.actor, authorization: value });
        this.requireAdvisorPermission(input.actor);
        if (Date.parse(value.expiresAt) <= this.deps.now().getTime()) throw Error('advisor_approval_expired');
        return result;
      });
    });
    if (result.status !== 'ok') return result;
    const change = result.policy.lifecycle;
    if (!change) return { status: 'unavailable', error: 'financial_unavailable', httpStatus: 503, traceId: input.traceId };
    return { status: 'ok', policyId: change.policyId, changeId: change.changeId, action: change.action, changedAt: change.at, replayed: result.replayed };
  }

  listOwn(input: { actor: FinancialActor; traceId: string; includeEnded?: boolean }): Promise<PolicyListResult> {
    return this.run<PolicyListResult>(input.traceId, async () => {
      if (!validActor(input.actor)) return reject('invalid_request', 400);
      const records = await this.deps.store.readOwnPolicies(input.actor, MAX_LISTED_POLICIES + 1, input.includeEnded ?? true);
      const policies: PolicySummary[] = [];
      for (const record of records.slice(0, MAX_LISTED_POLICIES)) {
        const { policy } = await this.checked(record, input.actor);
        policies.push(summary(policy));
      }
      return { status: 'ok', policies, hasMore: records.length > MAX_LISTED_POLICIES };
    });
  }

  // Facts of one issued policy after the full integrity check. A policy still in the purchase flow is not a portal policy:
  // like a missing import it is waiting, so the caller answers the opaque 404 without recording a security denial.
  private async issuedFacts(input: { actor: FinancialActor; policyId: string }, traceId: string): Promise<IssuedPolicyFacts | Extract<FinancialResult, { status: 'denied' }>> {
    if (!validActor(input.actor) || !UUID.test(input.policyId)) return reject('invalid_request', 400);
    const { policy, premium, signature } = await this.checked(await this.deps.store.readPolicy(input.policyId, input.actor), input.actor);
    if (policy.status !== 'issued') return { status: 'denied', error: 'policy_pending', httpStatus: 404, traceId };
    if (!premium || !signature || !premium.updatedAt) throw new InvalidFinancialRecord();
    return { ...(policy.lifecycle ? { lifecycle: policy.lifecycle } : {}), policyId: policy.id, offer: policy.offer, premium: policy.premium, currency: 'COP', effectiveFrom: policy.effectiveFrom,
      effectiveUntil: policy.effectiveUntil, documentHash: policy.documentHash, signedAt: signature.signedAt,
      payment: { status: premium.status, reference: premium.providerReference, amount: premium.amount, at: premium.updatedAt } };
  }

  detail(input: { actor: FinancialActor; policyId: string; traceId: string }): Promise<PolicyDetailResult> {
    return this.run<PolicyDetailResult>(input.traceId, async traceId => {
      const facts = await this.issuedFacts(input, traceId);
      return 'status' in facts ? facts : { status: 'ok', detail: policyDetail(facts) };
    });
  }

  document(input: { actor: FinancialActor; policyId: string; documentId: PolicyDocumentKind; traceId: string }): Promise<PolicyDocumentResult> {
    return this.run<PolicyDocumentResult>(input.traceId, async traceId => {
      const facts = await this.issuedFacts(input, traceId);
      if ('status' in facts) return facts;
      const file = documentFile(input.documentId, facts);
      if (file && facts.lifecycle) file.lines.unshift('Estado contractual: ' + facts.lifecycle.action,
        'Cambio registrado: ' + facts.lifecycle.at, 'Motivo: ' + facts.lifecycle.reason,
        'Reemplazo: ' + (facts.lifecycle.replacementPolicyId ?? 'no aplica'), 'Devolución automática: no realizada',
        'Huella del cambio: ' + facts.lifecycle.documentHash, 'El documento y el recibo originales se conservan como evidencia histórica.', '');
      return file ? { status: 'ok', file } : reject('not_found', 404);
    });
  }

  getByAcceptance(input: { actor: FinancialActor; acceptanceId: string; traceId: string }): Promise<FinancialResult> {
    return this.run(input.traceId, async traceId => {
      if (!validActor(input.actor) || !UUID.test(input.acceptanceId)) return reject('invalid_request', 400);
      const lookup = await this.deps.store.readAcceptedPolicy(input.acceptanceId, input.actor);
      // Delivery is asynchronous: before import, an owned pending acceptance and an unknown identifier look the same.
      // Waiting is not a rejection, so it records neither a financial rejection nor a security denial.
      if (lookup.status === 'absent') return { status: 'denied', error: 'policy_pending', httpStatus: 404, traceId };
      if (lookup.status === 'foreign') return reject('not_found', 404);
      const { policy, premium } = await this.checked(lookup.record, input.actor);
      return { status: 'ok', replayed: false, policy: view(policy), ...paid(premium) };
    });
  }

  beginSignatureChallenge(input: { actor: FinancialActor; policyId: string; documentHash: string; accepted: true; traceId: string }): Promise<FinancialResult> {
    return this.run(input.traceId, async traceId => {
      if (!validActor(input.actor) || !UUID.test(input.policyId) || !HEX.test(input.documentHash) || input.accepted !== true) return reject('invalid_request', 400);
      const code = String(parseInt(this.deps.newId().slice(0, 8), 16) % 1000000).padStart(6, '0');
      const challengeId = this.deps.newId();
      let expiresAt = '';
      const codeHash = await this.deps.integrity.digest(JSON.stringify(['signature-code-v1', challengeId, code]));
      const policy = await this.deps.store.transaction(async tx => {
        const { policy } = await this.checked(await tx.policy(input.policyId, input.actor), input.actor);
        if (policy.documentHash !== input.documentHash) return reject('document_mismatch');
        if (policy.status !== 'charged' || Date.parse(policy.offer.expiresAt) <= this.deps.now().getTime()) return reject('offer_invalid');
        expiresAt = new Date(Math.min(Date.parse(policy.offer.expiresAt), this.deps.now().getTime() + 5 * 60_000)).toISOString();
        await tx.createSignatureChallenge({ id: challengeId, policyId: policy.id, clientId: input.actor.clientId,
          subjectToken: input.actor.subjectToken, documentHash: policy.documentHash, codeHash, expiresAt,
          attempts: 0, status: 'active', commandKey: null });
        await tx.audit('signature.challenge_created', policy.id, traceId, 'active', policy.clientId,
          this.decision('signature.challenge_created', traceId, policy, 'active',
            { challenge: { id: challengeId, expiresAt, attempts: 0, accepted: true } }));
        return policy;
      });
      return { status: 'ok', replayed: false, policy: view(policy), challenge: { challengeId, expiresAt, demoCode: code } };
    });
  }

  cancelSignatureChallenge(input: { actor: FinancialActor; policyId: string; challengeId: string; traceId: string }): Promise<FinancialResult> {
    return this.run(input.traceId, async traceId => {
      if (!validActor(input.actor) || !UUID.test(input.policyId) || !UUID.test(input.challengeId)) return reject('invalid_request', 400);
      const policy = await this.deps.store.transaction(async tx => {
        const { policy } = await this.checked(await tx.policy(input.policyId, input.actor), input.actor);
        const challenge = await tx.signatureChallenge(input.challengeId, input.actor, policy.id);
        if (!challenge) return reject('challenge_invalid');
        if (challenge.status === 'consumed') return reject('challenge_invalid');
        if (challenge.status !== 'cancelled') {
          await tx.updateSignatureChallenge(challenge.id, challenge.attempts, 'cancelled');
          await tx.audit('signature.challenge_cancelled', policy.id, traceId, 'cancelled', policy.clientId,
            this.decision('signature.challenge_cancelled', traceId, policy, 'cancelled',
              { challenge: { id: challenge.id, expiresAt: challenge.expiresAt, attempts: challenge.attempts, accepted: true } }));
        }
        return policy;
      });
      return { status: 'ok', replayed: false, policy: view(policy) };
    });
  }

  charge(input: { actor: FinancialActor; policyId: string; idempotencyKey: string; documentHash: string; traceId: string }): Promise<FinancialResult> {
    return this.run(input.traceId, async traceId => {
      if (!validActor(input.actor) || !UUID.test(input.policyId) || !/^[\x21-\x7e]{1,128}$/.test(input.idempotencyKey)
        || !HEX.test(input.documentHash)) return reject('invalid_request', 400);
      const requestHash = await this.deps.integrity.digest(JSON.stringify(['charge.v1', input.actor.clientId, input.policyId, input.documentHash]));
      const commandKey = await this.deps.integrity.digest(JSON.stringify(['command-key.v1', input.actor.clientId, input.idempotencyKey]));
      const plan = await this.deps.store.transaction(async tx => {
        const snapshot = await tx.issuanceSnapshot(input.policyId, input.actor, commandKey);
        const { policy, premium } = await this.checked(snapshot.record, input.actor);
        if (policy.documentHash !== input.documentHash) return reject('document_mismatch');
        const previous = snapshot.command;
        if (previous && (previous.requestHash !== requestHash || previous.policyId !== policy.id)) return reject('idempotency_conflict');
        if (policy.status === 'refunded' || (policy.status === 'refunding' && !previous)) return reject('signature_failed');
        if (policy.status === 'issued') {
          if (!previous) await tx.createCommand(input.actor.clientId, commandKey, policy.id, requestHash);
          const result = view(policy); await tx.finishCommand(input.actor.clientId, commandKey, result);
          return { policy, payment: premium, replayed: !!previous, completed: result };
        }
        if (policy.status === 'refunding') {
          if (!premium) return reject('integrity_violation');
          return { policy, payment: premium, replayed: true, completed: null };
        }
        if (previous?.result) return reject('integrity_violation');
        let payment = premium;
        if (!payment) {
          if (this.deps.now().getTime() >= Date.parse(policy.offer.expiresAt)) return reject('offer_invalid');
          payment = { id: this.deps.newId(), policyId: policy.id, operation: 'premium', amount: policy.premium,
            currency: 'COP', key: 'initial-premium', hash: '', status: 'pending', providerReference: null };
          payment.hash = await this.deps.integrity.digest(paymentContent(payment));
          await tx.beginPremium({ policy, payment, command: previous ? null : { key: commandKey, requestHash }, traceId,
            capture: this.decision('premium.requested', traceId, policy, 'pending', { payment }) });
        } else if (!previous) await tx.createCommand(input.actor.clientId, commandKey, policy.id, requestHash);
        await this.checkPayment(payment, policy);
        if (payment.status === 'declined') return reject('payment_declined');
        return { policy, payment, replayed: !!previous, completed: null };
      });
      if (plan.completed) return { status: 'ok', replayed: plan.replayed, policy: plan.completed, ...paid(plan.payment) };
      if (!plan.payment) throw new Error('financial_plan_unavailable');
      return this.proceed({ actor: input.actor, policyId: input.policyId, documentHash: input.documentHash, commandKey, traceId },
        plan.policy, plan.payment, plan.replayed, true);
    });
  }

  // Preserve the v1 request shape for clients already loaded when v2 is deployed.
  issueLegacy(input: { actor: FinancialActor; policyId: string; idempotencyKey: string; documentHash: string; traceId: string }): Promise<FinancialResult> {
    return this.run(input.traceId, async traceId => {
      if (!validActor(input.actor) || !UUID.test(input.policyId) || !/^[\x21-\x7e]{1,128}$/.test(input.idempotencyKey)
        || !HEX.test(input.documentHash)) return reject('invalid_request', 400);
      const requestHash = await this.deps.integrity.digest(JSON.stringify(['issue.v1', input.actor.clientId, input.policyId, input.documentHash]));
      const commandKey = await this.deps.integrity.digest(JSON.stringify(['command-key.v1', input.actor.clientId, input.idempotencyKey]));
      const plan = await this.deps.store.transaction(async tx => {
        const snapshot = await tx.issuanceSnapshot(input.policyId, input.actor, commandKey);
        const { policy, premium } = await this.checked(snapshot.record, input.actor);
        if (policy.documentHash !== input.documentHash) return reject('document_mismatch');
        const previous = snapshot.command;
        if (previous && (previous.requestHash !== requestHash || previous.policyId !== policy.id)) return reject('idempotency_conflict');
        if (previous?.result) {
          if ((policy.status !== 'issued' && policy.status !== 'refunded')
            || historicalView(previous.result) !== historicalView(view(policy))) return reject('integrity_violation');
          if (policy.status === 'refunded') return reject('signature_failed');
          return { policy, payment: premium, replayed: true, completed: view(policy) };
        }
        if (policy.status === 'refunded') return reject('signature_failed');
        if (policy.status === 'issued') {
          if (!previous) await tx.createCommand(input.actor.clientId, commandKey, policy.id, requestHash);
          const result = view(policy); await tx.finishCommand(input.actor.clientId, commandKey, result);
          return { policy, payment: premium, replayed: !!previous, completed: result };
        }
        let payment = premium;
        if (!payment) {
          if (this.deps.now().getTime() >= Date.parse(policy.offer.expiresAt)) return reject('offer_invalid');
          payment = { id: this.deps.newId(), policyId: policy.id, operation: 'premium', amount: policy.premium,
            currency: 'COP', key: 'initial-premium', hash: '', status: 'pending', providerReference: null };
          payment.hash = await this.deps.integrity.digest(paymentContent(payment));
          await tx.beginPremium({ policy, payment, command: previous ? null : { key: commandKey, requestHash }, traceId,
            capture: this.decision('premium.requested', traceId, policy, 'pending', { payment }) });
        } else if (!previous) await tx.createCommand(input.actor.clientId, commandKey, policy.id, requestHash);
        await this.checkPayment(payment, policy);
        if (payment.status === 'declined') return reject('payment_declined');
        return { policy, payment, replayed: !!previous, completed: null };
      });
      if (plan.completed) return { status: 'ok', replayed: plan.replayed, policy: plan.completed, ...paid(plan.payment) };
      if (!plan.payment) throw new Error('financial_plan_unavailable');
      return this.proceed({ actor: input.actor, policyId: input.policyId, documentHash: input.documentHash, commandKey, traceId },
        plan.policy, plan.payment, plan.replayed);
    });
  }

  issue(input: { actor: FinancialActor; policyId: string; idempotencyKey: string; documentHash: string;
    challengeId: string; code: string; traceId: string }): Promise<FinancialResult> {
    return this.run(input.traceId, async traceId => {
      if (!validActor(input.actor) || !UUID.test(input.policyId) || typeof input.idempotencyKey !== 'string'
        || !/^[\x21-\x7e]{1,128}$/.test(input.idempotencyKey) || !HEX.test(input.documentHash)
        || !UUID.test(input.challengeId) || !/^[0-9]{6}$/.test(input.code)) return reject('invalid_request', 400);
      const requestHash = await this.deps.integrity.digest(JSON.stringify(['issue.v2', input.actor.clientId, input.policyId, input.documentHash]));
      const commandKey = await this.deps.integrity.digest(JSON.stringify(['command-key.v1', input.actor.clientId, input.idempotencyKey]));
      const plan = await this.deps.store.transaction(async tx => {
        const snapshot = await tx.issuanceSnapshot(input.policyId, input.actor, commandKey);
        const { policy, premium } = await this.checked(snapshot.record, input.actor);
        if (policy.documentHash !== input.documentHash) return reject('document_mismatch');
        const previous = snapshot.command;
        if (previous && (previous.requestHash !== requestHash || previous.policyId !== policy.id)) return reject('idempotency_conflict');
        if (previous?.result) {
          if ((policy.status !== 'issued' && policy.status !== 'refunded')
            || historicalView(previous.result) !== historicalView(view(policy))) return reject('integrity_violation');
          if (policy.status === 'refunded') return reject('signature_failed');
          return { policy, payment: premium, replayed: true, completed: view(policy) };
        }
        if (policy.status === 'refunded') return reject('signature_failed');
        if (policy.status === 'issued') {
          if (!previous) await tx.createCommand(input.actor.clientId, commandKey, policy.id, requestHash);
          const result = view(policy); await tx.finishCommand(input.actor.clientId, commandKey, result);
          return { policy, payment: premium, replayed: !!previous, completed: result };
        }
        if (!previous && (policy.status !== 'charged' || premium?.status !== 'confirmed')) return reject('challenge_invalid');
        const challenge = await tx.signatureChallenge(input.challengeId, input.actor, policy.id);
        if (!challenge || challenge.documentHash !== policy.documentHash || challenge.status === 'cancelled') return { error: 'challenge_invalid' as const };
        if (challenge.status === 'active') {
          if (this.deps.now().getTime() >= Date.parse(challenge.expiresAt)) return { error: 'challenge_expired' as const };
          if (!(await this.deps.integrity.verify(JSON.stringify(['signature-code-v1', challenge.id, input.code]), challenge.codeHash))) {
            await tx.updateSignatureChallenge(challenge.id, Math.min(challenge.attempts + 1, 3), challenge.attempts >= 2 ? 'cancelled' : 'active');
            await tx.audit('signature.challenge_failed', policy.id, traceId, 'authentication_failed', policy.clientId,
              this.decision('signature.challenge_failed', traceId, policy, 'authentication_failed',
                { challenge: { id: challenge.id, expiresAt: challenge.expiresAt, attempts: challenge.attempts + 1, accepted: true } }));
            return { error: 'authentication_failed' as const };
          }
          await tx.updateSignatureChallenge(challenge.id, challenge.attempts, 'consumed', commandKey);
          await tx.audit('signature.challenge_verified', policy.id, traceId, 'verified', policy.clientId,
            this.decision('signature.challenge_verified', traceId, policy, 'verified',
              { challenge: { id: challenge.id, expiresAt: challenge.expiresAt, attempts: challenge.attempts, accepted: true } }));
        } else if (challenge.commandKey !== commandKey || !previous) return { error: 'challenge_invalid' as const };
        let payment = premium;
        if (!payment) {
          if (this.deps.now().getTime() >= Date.parse(policy.offer.expiresAt)) return reject('offer_invalid');
          payment = { id: this.deps.newId(), policyId: policy.id, operation: 'premium', amount: policy.premium,
            currency: 'COP', key: 'initial-premium', hash: '', status: 'pending', providerReference: null };
          payment.hash = await this.deps.integrity.digest(paymentContent(payment));
          await tx.beginPremium({ policy, payment, command: previous ? null : { key: commandKey, requestHash }, traceId,
            capture: this.decision('premium.requested', traceId, policy, 'pending', { payment }) });
        } else if (!previous) await tx.createCommand(input.actor.clientId, commandKey, policy.id, requestHash);
        await this.checkPayment(payment, policy);
        if (payment.status === 'declined') return reject('payment_declined');
        return { policy, payment, replayed: !!previous, completed: null };
      });
      if ('error' in plan && plan.error) return reject(plan.error);
      if (plan.completed) return { status: 'ok', replayed: plan.replayed, policy: plan.completed, ...paid(plan.payment) };
      if (!plan.payment) throw new Error('financial_plan_unavailable');
      return this.proceed({ actor: input.actor, policyId: input.policyId, documentHash: input.documentHash, commandKey, traceId }, plan.policy, plan.payment, plan.replayed);
    });
  }

  // Completes customer commands that stopped after a provider charge may have committed, without waiting for a client retry.
  async reconcileIssuances(staleBefore: Date, limit: number): Promise<ReconciliationOutcome[]> {
    if (!this.deps.enabled) return [];
    const outcomes: ReconciliationOutcome[] = [];
    for (const candidate of await this.deps.store.issuanceCandidates(staleBefore, limit)) outcomes.push(await this.reconcile(candidate));
    return outcomes;
  }

  private async reconcile(candidate: IssuanceCandidate): Promise<ReconciliationOutcome> {
    let unchanged = false;
    const traceId = this.deps.newId();
    const result = await this.run(traceId, async () => {
      const { actor, policyId, commandKey } = candidate;
      const plan = await this.deps.store.transaction(async (tx): Promise<{ policy: StoredPolicy; payment: Payment | null; charge: boolean }> => {
        const snapshot = await tx.issuanceSnapshot(policyId, actor, commandKey);
        const { policy, premium } = await this.checked(snapshot.record, actor);
        // Recovery acts only on the customer's stored command for this exact reviewed document.
        const issueHashes = await Promise.all(['issue.v1', 'issue.v2'].map(version =>
          this.deps.integrity.digest(JSON.stringify([version, actor.clientId, policy.id, policy.documentHash]))));
        const chargeHash = await this.deps.integrity.digest(JSON.stringify(['charge.v1', actor.clientId, policy.id, policy.documentHash]));
        const command = snapshot.command;
        if (!command || command.policyId !== policy.id || ![...issueHashes, chargeHash].includes(command.requestHash)) return reject('integrity_violation');
        if ((policy.status === 'issued' || policy.status === 'refunded') && !command.result) await tx.finishCommand(actor.clientId, commandKey, view(policy));
        if (command.result || policy.status === 'issued' || policy.status === 'refunded' || !premium || premium.status === 'declined')
          return { policy, payment: null, charge: command.requestHash === chargeHash };
        return { policy, payment: premium, charge: command.requestHash === chargeHash };
      });
      const { policy, payment } = plan;
      // A pending intent is only continued when the provider already holds its charge; recovery never starts a new one.
      if (!payment || (policy.status === 'pending' && (await this.deps.payments.lookup(payment)).status !== 'confirmed')) {
        unchanged = true; return { status: 'ok', replayed: true, policy: view(policy) };
      }
      return this.proceed({ actor, policyId, documentHash: policy.documentHash, commandKey, traceId, trigger: 'reconciliation' },
        policy, payment, true, plan.charge);
    });
    if (result.status === 'unavailable') return { traceId, outcome: 'unavailable' };
    if (result.status === 'denied') {
      if (result.error !== 'signature_failed') return { traceId, outcome: 'rejected', error: result.error };
      // A concurrent request may still be refunding. The error alone never proves a completed compensation.
      const current = await this.get({ actor: candidate.actor, policyId: candidate.policyId, traceId });
      if (current.status === 'unavailable') return { traceId, outcome: 'unavailable' };
      if (current.status === 'denied') return { traceId, outcome: 'rejected', error: current.error };
      return { traceId, outcome: current.policy.status === 'refunded' ? 'refunded' : current.policy.status === 'issued' ? 'issued' : 'unchanged' };
    }
    return { traceId, outcome: !unchanged && result.policy.status === 'issued' ? 'issued' : 'unchanged' };
  }

  // Continues a planned issuance from durable state: confirm the charge, then sign and issue, or compensate.
  private async proceed(context: IssuanceContext, planned: StoredPolicy, payment: Payment, replayed: boolean, stopAfterCharge = false): Promise<FinancialResult> {
    const { actor, policyId, documentHash, commandKey, traceId } = context;
    const by: FinancialEvidence = context.trigger ? { trigger: context.trigger } : {};
    const refund = async (reason: FinancialEvidence['refundReason'] = 'existing_refund_intent', sources: FinancialSource[] = []): Promise<FinancialResult> => {
      const refundPlan = await this.deps.store.transaction(async tx => {
        const { policy, premium } = await this.checked(await tx.policy(policyId, actor), actor);
        if (policy.status === 'issued') {
          const result = view(policy); await tx.finishCommand(actor.clientId, commandKey, result); return { completed: result, payment: premium };
        }
        if (policy.status === 'refunded') return reject('signature_failed');
        if (policy.status !== 'charged' && policy.status !== 'refunding') throw new Error('financial_refund_state_invalid');
        if (!premium || premium.status !== 'confirmed') return reject('integrity_violation');
        await this.checkPayment(premium, policy);
        if (policy.status !== 'refunding') {
          await tx.setPolicyStatus(policy.id, 'refunding');
          await tx.audit('premium.refund_requested', policy.id, traceId, 'refunding', policy.clientId,
            this.decision('premium.refund_requested', traceId, policy, 'refunding', { ...by, payment: premium, refundReason: reason, sources }));
        }
        return { completed: null, payment: premium };
      });
      if (refundPlan.completed) return { status: 'ok', replayed: true, policy: refundPlan.completed, ...paid(refundPlan.payment) };
      const refundPayment = refundPlan.payment;
      if (!refundPayment) throw new Error('financial_refund_intent_missing');
      const known = await this.deps.payments.lookup(refundPayment);
      const lookupSource = gatewaySource('lookup', known, refundPayment, this.deps.now().toISOString());
      if (!refundPayment.providerReference || known.reference !== refundPayment.providerReference
        || (known.status !== 'confirmed' && known.status !== 'refunded')) return reject('integrity_violation');
      const refunded = await this.deps.payments.refund(refundPayment);
      const refundSource = gatewaySource('refund', refunded, refundPayment, this.deps.now().toISOString());
      if (refunded.status !== 'refunded') throw new Error('financial_refund_uncertain');
      await this.deps.store.transaction(async tx => {
        const { policy } = await this.checked(await tx.policy(policyId, actor), actor);
        if (policy.status === 'refunded') return;
        if (policy.status !== 'refunding') throw new Error('financial_refund_state_invalid');
        await tx.setPaymentStatus(refundPayment.id, 'refunded', refunded.reference);
        await tx.setPolicyStatus(policy.id, 'refunded');
        await tx.audit('premium.refunded', policy.id, traceId, 'refunded', policy.clientId,
          this.decision('premium.refunded', traceId, policy, 'refunded', { ...by, payment: { ...refundPayment, status: 'refunded', providerReference: refunded.reference },
            refundReason: reason, sources: [lookupSource, refundSource] }));
      });
      return reject('signature_failed');
    };
    if (planned.status === 'refunding') return refund();
    const settled = await this.settle(payment, this.deps.now().getTime() < Date.parse(planned.offer.expiresAt));
    if (settled.status === 'uncertain') throw new Error('financial_provider_uncertain');
    if (settled.status === 'declined') {
      const refundInProgress = await this.deps.store.transaction(async tx => {
        const { policy } = await this.checked(await tx.policy(policyId, actor), actor);
        if (policy.status === 'refunding') return true;
        if (policy.status === 'refunded') return reject('signature_failed');
        await tx.setPaymentStatus(payment.id, 'declined', settled.reference);
        await tx.audit('premium.declined', policy.id, traceId, 'declined', policy.clientId,
          this.decision('premium.declined', traceId, policy, 'declined', { ...by, payment: { ...payment, status: 'declined', providerReference: settled.reference }, sources: settled.sources }));
        return false;
      });
      if (refundInProgress) return refund();
      return reject('payment_declined');
    }
    const completed = await this.deps.store.transaction(async tx => {
      const { policy, premium } = await this.checked(await tx.policy(policyId, actor), actor);
      if (policy.status === 'refunding') return null;
      if (policy.status === 'refunded') return reject('signature_failed');
      if (policy.status === 'issued') {
        const result = view(policy); await tx.finishCommand(actor.clientId, commandKey, result); return { result, premium };
      }
      if (policy.status === 'pending') {
        if (!premium || premium.id !== payment.id) return reject('integrity_violation');
        const confirmedPayment: Payment = { ...premium, status: 'confirmed', providerReference: settled.reference };
        await tx.confirmPremium(policy, confirmedPayment, traceId,
          this.decision('premium.confirmed', traceId, policy, 'confirmed', { ...by, payment: confirmedPayment, sources: settled.sources }));
      }
      return null;
    });
    if (completed) return { status: 'ok', replayed: true, policy: completed.result, ...paid(completed.premium) };
    if (stopAfterCharge) {
      if (this.deps.now().getTime() >= Date.parse(planned.offer.expiresAt)) return refund('expired_before_sign');
      const charged = await this.deps.store.transaction(async tx => this.checked(await tx.policy(policyId, actor), actor));
      if (charged.policy.status !== 'charged' || charged.premium?.status !== 'confirmed') return reject('integrity_violation');
      return { status: 'ok', replayed, policy: view(charged.policy), ...paid(charged.premium) };
    }
    const expiredBeforeSignature = this.deps.now().getTime() >= Date.parse(planned.offer.expiresAt);
    const signature = expiredBeforeSignature ? { status: 'failed' as const } : await this.deps.signatures.sign(policyId, documentHash);
    const signatureSources: FinancialSource[] = expiredBeforeSignature ? [] : [{ source: 'synthetic-signature-v1', capturedAt: this.deps.now().toISOString(),
      quality: 'synthetic_result', degraded: false, operation: 'sign', result: signature.status }];
    if (signature.status === 'failed' || this.deps.now().getTime() >= Date.parse(planned.offer.expiresAt) || !HEX.test(signature.receipt)
      || !(await this.deps.integrity.verify(JSON.stringify(['mock-signature-v1', policyId, documentHash]), signature.receipt))) {
      return refund(expiredBeforeSignature || this.deps.now().getTime() >= Date.parse(planned.offer.expiresAt) ? (expiredBeforeSignature ? 'expired_before_sign' : 'expired_after_sign')
        : signature.status === 'failed' ? 'signature_refused' : 'signature_invalid', signatureSources);
    }
    const final = await this.deps.store.transaction(async tx => {
      const { policy, premium } = await this.checked(await tx.policy(policyId, actor), actor);
      if (policy.status === 'refunded' || policy.status === 'refunding') return reject('signature_failed');
      if (policy.status === 'issued') {
        const result = view(policy);
        await tx.finishCommand(actor.clientId, commandKey, result);
        return { status: 'ok' as const, replayed, policy: result, ...paid(premium) };
      }
      if (policy.status !== 'charged') throw new Error('financial_charge_missing');
      if (!premium) throw new Error('financial_intent_missing');
      const signedAt = this.deps.now().toISOString();
      if (Date.parse(signedAt) >= Date.parse(policy.offer.expiresAt)) {
        await tx.setPolicyStatus(policy.id, 'refunding');
        await tx.audit('premium.refund_requested', policy.id, traceId, 'refunding', policy.clientId,
          this.decision('premium.refund_requested', traceId, policy, 'refunding', { ...by, payment: premium,
            refundReason: 'expired_during_final_transaction', sources: signatureSources }));
        return null;
      }
      const timeSeal = await this.deps.integrity.digest(issuanceTimeContent(policy.id, documentHash, signedAt));
      const issuance = { documentHash, receipt: signature.receipt, signedAt, timeSeal };
      const result = view({ ...policy, status: 'issued' });
      const stored = await tx.completeIssuance({ policy, signature: issuance, commandKey, result, traceId,
        capture: this.decision('policy.issued', traceId, policy, 'issued', { ...by, payment: premium, sources: signatureSources,
          issuance: { signedAt, documentHash } }) });
      // The transaction commits only after the stored evidence matches the reviewed document and provider receipt.
      if (!stored || stored.documentHash !== issuance.documentHash || stored.receipt !== issuance.receipt
        || stored.signedAt !== signedAt || stored.timeSeal !== timeSeal) throw new Error('financial_issuance_evidence_missing');
      return { status: 'ok' as const, replayed, policy: result, ...paid(premium) };
    });
    return final ?? refund();
  }

  private async checkPayment(payment: Payment, policy: StoredPolicy): Promise<void> {
    const amount = payment.operation === 'premium' ? policy.premium : indemnityAmount(policy.offer.coverage);
    if (!amount || !UUID.test(payment.id) || payment.policyId !== policy.id || payment.amount !== amount || payment.currency !== 'COP'
      || payment.key !== (payment.operation === 'premium' ? 'initial-premium' : 'parametric-once')
      || (payment.status === 'pending' && payment.providerReference !== null)
      || (['confirmed', 'refunded'].includes(payment.status) && payment.providerReference !== 'MOCK-' + payment.id)
      || !(await this.deps.integrity.verify(paymentContent(payment), payment.hash))) return reject('integrity_violation');
  }

  private async settle(payment: Payment, allowNew = true) {
    const known = await this.deps.payments.lookup(payment);
    const lookupSource = gatewaySource('lookup', known, payment, this.deps.now().toISOString());
    if (known.status !== 'unknown' && known.status !== 'declined' && known.reference !== 'MOCK-' + payment.id) return reject('integrity_violation');
    if (payment.status !== 'pending') {
      if (payment.status !== 'confirmed' || known.status !== 'confirmed'
        || !payment.providerReference || known.reference !== payment.providerReference) return reject('integrity_violation');
      return { ...known, sources: [lookupSource] };
    }
    if (known.status === 'refunded') return reject('integrity_violation');
    if (known.status !== 'unknown') return { ...known, sources: [lookupSource] };
    if (!allowNew) return reject('offer_invalid');
    const settled = await this.deps.payments.settle(payment);
    return { ...settled, sources: [lookupSource, gatewaySource('settle', settled, payment, this.deps.now().toISOString())] };
  }

  // Internal Queue boundary: a sealed flight-delay envelope from the synthetic oracle.
  consumeParametricEvent(input: unknown, trace: string): Promise<FinancialResult> {
    return this.run(trace, async traceId => {
      if (!isParametricEnvelope(input, this.deps.environment) || Date.parse(input.occurredAt) > this.deps.now().getTime() + 60000
        || !(await this.deps.integrity.verify(eventContent(input), input.signature))) return reject('invalid_event', 400);
      const occurrence: ParametricOccurrence = { eventId: input.eventId, eventType: input.eventType, occurredAt: input.occurredAt, payload: input.payload };
      const { policy, replayed } = await this.applyOccurrence(traceId, occurrence, await this.deps.integrity.digest(eventContent(input)),
        financialEventSource(input, this.deps.now().toISOString()));
      return { status: 'ok', replayed, policy: view(policy) };
    });
  }

  // Private RPC boundary: the provider adapter authenticates and translates its own versioned format before the shared core runs.
  receiveParametricEvent(input: unknown, trace: string): Promise<ParametricResult> {
    return this.run<Extract<ParametricResult, { status: 'ok' }>>(trace, async traceId => {
      const received = await this.deps.parametric.receive(input);
      if (received.status !== 'verified' || Date.parse(received.occurrence.occurredAt) > this.deps.now().getTime() + 60000) return reject('invalid_event', 400);
      const { policy, replayed, reference } = await this.applyOccurrence(traceId, received.occurrence, await this.deps.integrity.digest(received.content),
        providerEventSource(received.occurrence, this.deps.now().toISOString()));
      return { status: 'ok', replayed, policyId: policy.id, indemnity: { status: 'confirmed', reference } };
    });
  }

  // One effect per policy: the first covered occurrence creates the claim, indemnity and payment; any other identity or content is a conflict.
  private async applyOccurrence(traceId: string, occurrence: ParametricOccurrence, hash: string, source: FinancialSource) {
    const event = occurrenceEvidence(occurrence, this.deps.environment);
    const plan = await this.deps.store.transaction(async tx => {
      const { policy, signature } = await this.checked(await tx.policy(occurrence.payload.policyId));
      const previous = await tx.inbox(occurrence.eventId, 'policy.parametric.v1');
      if (previous && (previous.hash !== hash || previous.policyId !== policy.id)) return reject('event_conflict');
      if (policy.status !== 'issued') return reject('policy_not_active');
      if (!previous && policy.lifecycle && Date.parse(occurrence.occurredAt) >= Date.parse(policy.lifecycle.at)) return reject('event_not_covered');
      const coverage = policy.offer.coverage;
      const amount = indemnityAmount(coverage);
      if (!amount || !occurrenceCovered(coverage, occurrence) || !signature
        || !eventWithinIssuedCoverage(occurrence.occurredAt, signature.signedAt, policy.effectiveFrom, policy.effectiveUntil)) return reject('event_not_covered');
      let payment = await tx.payment(policy.id, 'indemnity');
      if (!previous && payment) return reject('event_conflict');
      if (!payment) {
        payment = { id: this.deps.newId(), policyId: policy.id, operation: 'indemnity', amount,
          currency: 'COP', key: 'parametric-once', hash: '', status: 'pending', providerReference: null };
        payment.hash = await this.deps.integrity.digest(paymentContent(payment));
        await tx.createPayment(payment, traceId, { id: this.deps.newId(), indemnityId: this.deps.newId(), occurredAt: occurrence.occurredAt });
        await tx.recordInbox(occurrence.eventId, 'policy.parametric.v1', hash, policy.id, occurrence.eventType, traceId);
        await tx.audit('parametric.accepted', policy.id, traceId, 'accepted', source.source,
          this.decision('parametric.accepted', traceId, policy, 'accepted', { payment, sources: [source],
            issuance: { signedAt: signature.signedAt, documentHash: signature.documentHash }, event }));
      }
      await this.checkPayment(payment, policy);
      return { policy, payment, replayed: !!previous };
    });
    const reference = await this.settleIndemnity(plan.payment, traceId, source.source, [source], event);
    return { policy: plan.policy, replayed: plan.replayed, reference };
  }

  // Provider settlement, then the confirmation with its audit and customer notice in one owner transaction.
  // An uncertain provider result throws before anything is announced, so only a confirmed payment reaches the customer.
  private async settleIndemnity(payment: Payment, traceId: string, actor: string, sources: FinancialSource[], event: FinancialEvidence['event'], trigger?: 'reconciliation'): Promise<string> {
    if (payment.status === 'declined') return reject('payment_declined');
    const settled = await this.settle(payment);
    if (settled.status === 'uncertain') throw new Error('financial_provider_uncertain');
    if (settled.status === 'declined') {
      await this.recordDeclinedIndemnity(payment, traceId, actor, [...sources, ...settled.sources], settled.reference, event, trigger);
      return reject('payment_declined');
    }
    if (!settled.reference) throw new Error('financial_provider_reference_missing');
    const { reference } = settled;
    await this.deps.store.transaction(async tx => {
      const { policy, signature } = await this.checked(await tx.policy(payment.policyId));
      const current = await tx.payment(policy.id, 'indemnity');
      if (!current) throw new Error('financial_intent_missing');
      await this.checkPayment(current, policy);
      if (current.status === 'confirmed') return;
      const { kind } = policy.offer.coverage;
      if (!signature || kind === 'mortgage_life') throw new Error('financial_issuance_evidence_missing');
      await tx.setPaymentStatus(current.id, 'confirmed', reference);
      await tx.audit('indemnity.confirmed', policy.id, traceId, 'confirmed', actor,
        this.decision('indemnity.confirmed', traceId, policy, 'confirmed', { payment: { ...current, status: 'confirmed', providerReference: reference },
          sources: [...sources, ...settled.sources], issuance: { signedAt: signature.signedAt, documentHash: signature.documentHash }, event, ...(trigger ? { trigger } : {}) }));
      await tx.announceIndemnity({ paymentId: current.id, policyId: policy.id, clientId: policy.clientId, coverageKind: kind,
        confirmedAt: this.deps.now().toISOString() }, traceId);
    });
    return reference;
  }

  // A declined payment is terminal: it is recorded with its decision so the recovery stops selecting it and a replay never reaches the gateway again.
  private async recordDeclinedIndemnity(payment: Payment, traceId: string, actor: string, sources: FinancialSource[], reference: string | null,
    event: FinancialEvidence['event'], trigger?: 'reconciliation'): Promise<void> {
    await this.deps.store.transaction(async tx => {
      const { policy, signature } = await this.checked(await tx.policy(payment.policyId));
      const current = await tx.payment(policy.id, 'indemnity');
      if (!current) throw new Error('financial_intent_missing');
      await this.checkPayment(current, policy);
      if (current.status !== 'pending') return;
      if (!signature) throw new Error('financial_issuance_evidence_missing');
      await tx.setPaymentStatus(current.id, 'declined', reference);
      await tx.audit('indemnity.declined', policy.id, traceId, 'declined', actor,
        this.decision('indemnity.declined', traceId, policy, 'declined', { payment: { ...current, status: 'declined', providerReference: reference },
          sources, issuance: { signedAt: signature.signedAt, documentHash: signature.documentHash }, event, ...(trigger ? { trigger } : {}) }));
    });
  }

  // Finishes indemnities whose event was accepted but whose payment stayed pending (a crash between the two transactions, or an
  // uncertain provider answer). Settlement is idempotent per payment, so recovery never pays twice and never starts a second effect.
  async reconcileIndemnities(staleBefore: Date, limit: number): Promise<IndemnityOutcome[]> {
    if (!this.deps.enabled) return [];
    const outcomes: IndemnityOutcome[] = [];
    for (const candidate of await this.deps.store.pendingIndemnities(staleBefore, limit)) outcomes.push(await this.recoverIndemnity(candidate));
    return outcomes;
  }

  private async recoverIndemnity(candidate: IndemnityCandidate): Promise<IndemnityOutcome> {
    const traceId = this.deps.newId();
    let unchanged = false;
    const result = await this.run<{ status: 'ok' }>(traceId, async () => {
      const payment = await this.deps.store.transaction(async tx => {
        const { policy } = await this.checked(await tx.policy(candidate.policyId));
        const pending = await tx.payment(policy.id, 'indemnity');
        if (!pending) return reject('integrity_violation');
        await this.checkPayment(pending, policy);
        return pending;
      });
      if (payment.status === 'confirmed') { unchanged = true; return { status: 'ok' }; }
      await this.settleIndemnity(payment, traceId, 'financial-reconciliation-v1', candidate.sources, candidate.event, 'reconciliation');
      return { status: 'ok' };
    });
    if (result.status === 'unavailable') return { traceId, outcome: 'unavailable' };
    if (result.status === 'denied') return { traceId, outcome: 'rejected', error: result.error };
    return { traceId, outcome: unchanged ? 'unchanged' : 'confirmed' };
  }
}

export { FINANCIAL_RULE };
