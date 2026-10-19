import { canonical, eventContent, eventWithinIssuedCoverage, FINANCIAL_RULE, HEX, InvalidFinancialRecord, isAcceptedOffer, isOfferEnvelope, isParametricEnvelope, issuanceTimeContent, iso, offerContent, paymentContent, policyDocument, UUID } from '../domain/financial';
import type { FinancialActor, FinancialErrorCode, FinancialResult, PolicyView } from '../domain/financial';
import type { FinancialDependencies, Payment, PolicyRecord, StoredPolicy } from './ports/financial';
import { financialDecision, financialEventSource, financialRejection, gatewaySource } from './financial-decision';
import type { FinancialAction, FinancialEvidence, FinancialSource } from './financial-decision';

class Rejection extends Error {
  constructor(readonly code: FinancialErrorCode, readonly httpStatus: 400 | 403 | 404 | 409 = 409) { super(code); }
}
const reject = (code: FinancialErrorCode, httpStatus: 400 | 403 | 404 | 409 = 409): never => { throw new Rejection(code, httpStatus); };
const view = (policy: StoredPolicy): PolicyView => ({ policyId: policy.id, offerId: policy.offerId, offerVersion: policy.offerVersion,
  status: policy.status, premium: policy.premium, currency: 'COP', effectiveFrom: policy.effectiveFrom,
  effectiveUntil: policy.effectiveUntil, document: policy.document, documentHash: policy.documentHash, synthetic: true, providerMode: 'mock' });
const validActor = (actor: FinancialActor) => UUID.test(actor.clientId) && UUID.test(actor.subjectToken);

export class PolicyFinance {
  constructor(private readonly deps: FinancialDependencies) {}

  private async run(trace: string, operation: (traceId: string) => Promise<FinancialResult>): Promise<FinancialResult> {
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
    return this.run(input.traceId, async () => {
      if (!validActor(input.actor) || !UUID.test(input.policyId)) return reject('invalid_request', 400);
      return { status: 'ok', replayed: false,
        policy: view((await this.checked(await this.deps.store.readPolicy(input.policyId, input.actor), input.actor)).policy) };
    });
  }

  getByAcceptance(input: { actor: FinancialActor; acceptanceId: string; traceId: string }): Promise<FinancialResult> {
    return this.run(input.traceId, async traceId => {
      if (!validActor(input.actor) || !UUID.test(input.acceptanceId)) return reject('invalid_request', 400);
      const stored = await this.deps.store.readAcceptedPolicy(input.acceptanceId, input.actor);
      // Delivery is asynchronous: before import, an owned pending acceptance and an unknown identifier look the same.
      // Waiting is not a rejection, so it records neither a financial rejection nor a security denial.
      if (!stored) return { status: 'denied', error: 'policy_pending', httpStatus: 404, traceId };
      return { status: 'ok', replayed: false, policy: view((await this.checked(stored, input.actor)).policy) };
    });
  }

  issue(input: { actor: FinancialActor; policyId: string; idempotencyKey: string; documentHash: string; traceId: string }): Promise<FinancialResult> {
    return this.run(input.traceId, async traceId => {
      if (!validActor(input.actor) || !UUID.test(input.policyId) || typeof input.idempotencyKey !== 'string'
        || !/^[\x21-\x7e]{1,128}$/.test(input.idempotencyKey) || !HEX.test(input.documentHash)) return reject('invalid_request', 400);
      const requestHash = await this.deps.integrity.digest(JSON.stringify(['issue.v1', input.actor.clientId, input.policyId, input.documentHash]));
      const commandKey = await this.deps.integrity.digest(JSON.stringify(['command-key.v1', input.actor.clientId, input.idempotencyKey]));
      const plan = await this.deps.store.transaction(async tx => {
        const snapshot = await tx.issuanceSnapshot(input.policyId, input.actor, commandKey);
        const { policy, premium } = await this.checked(snapshot.record, input.actor);
        if (policy.documentHash !== input.documentHash) return reject('document_mismatch');
        const previous = snapshot.command;
        if (previous && (previous.requestHash !== requestHash || previous.policyId !== policy.id)) return reject('idempotency_conflict');
        if (previous?.result) {
          if (policy.status !== 'issued' || canonical(previous.result) !== canonical(view(policy))) return reject('integrity_violation');
          return { policy, payment: null, replayed: true, completed: view(policy) };
        }
        if (policy.status === 'refunded') return reject('signature_failed');
        if (policy.status === 'issued') {
          if (!previous) await tx.createCommand(input.actor.clientId, commandKey, policy.id, requestHash);
          const result = view(policy); await tx.finishCommand(input.actor.clientId, commandKey, result);
          return { policy, payment: null, replayed: !!previous, completed: result };
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
      if (plan.completed) return { status: 'ok', replayed: plan.replayed, policy: plan.completed };
      if (!plan.payment) throw new Error('financial_plan_unavailable');
      const payment = plan.payment;
      const refund = async (reason: FinancialEvidence['refundReason'] = 'existing_refund_intent', sources: FinancialSource[] = []): Promise<FinancialResult> => {
        const refundPlan = await this.deps.store.transaction(async tx => {
          const { policy, premium } = await this.checked(await tx.policy(input.policyId, input.actor), input.actor);
          if (policy.status === 'issued') {
            const result = view(policy); await tx.finishCommand(input.actor.clientId, commandKey, result); return { completed: result, payment: null };
          }
          if (policy.status === 'refunded') return reject('signature_failed');
          if (policy.status !== 'charged' && policy.status !== 'refunding') throw new Error('financial_refund_state_invalid');
          if (!premium || premium.status !== 'confirmed') return reject('integrity_violation');
          await this.checkPayment(premium, policy);
          if (policy.status !== 'refunding') {
            await tx.setPolicyStatus(policy.id, 'refunding');
            await tx.audit('premium.refund_requested', policy.id, traceId, 'refunding', policy.clientId,
              this.decision('premium.refund_requested', traceId, policy, 'refunding', { payment: premium, refundReason: reason, sources }));
          }
          return { completed: null, payment: premium };
        });
        if (refundPlan.completed) return { status: 'ok', replayed: true, policy: refundPlan.completed };
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
          const { policy } = await this.checked(await tx.policy(input.policyId, input.actor), input.actor);
          if (policy.status === 'refunded') return;
          if (policy.status !== 'refunding') throw new Error('financial_refund_state_invalid');
          await tx.setPaymentStatus(refundPayment.id, 'refunded', refunded.reference);
          await tx.setPolicyStatus(policy.id, 'refunded');
          await tx.audit('premium.refunded', policy.id, traceId, 'refunded', policy.clientId,
            this.decision('premium.refunded', traceId, policy, 'refunded', { payment: { ...refundPayment, status: 'refunded', providerReference: refunded.reference },
              refundReason: reason, sources: [lookupSource, refundSource] }));
        });
        return reject('signature_failed');
      };
      if (plan.policy.status === 'refunding') return refund();
      const settled = await this.settle(payment, this.deps.now().getTime() < Date.parse(plan.policy.offer.expiresAt));
      if (settled.status === 'uncertain') throw new Error('financial_provider_uncertain');
      if (settled.status === 'declined') {
        const refundInProgress = await this.deps.store.transaction(async tx => {
          const { policy } = await this.checked(await tx.policy(input.policyId, input.actor), input.actor);
          if (policy.status === 'refunding') return true;
          if (policy.status === 'refunded') return reject('signature_failed');
          await tx.setPaymentStatus(payment.id, 'declined', settled.reference);
          await tx.audit('premium.declined', policy.id, traceId, 'declined', policy.clientId,
            this.decision('premium.declined', traceId, policy, 'declined', { payment: { ...payment, status: 'declined', providerReference: settled.reference }, sources: settled.sources }));
          return false;
        });
        if (refundInProgress) return refund();
        return reject('payment_declined');
      }
      const completed = await this.deps.store.transaction(async tx => {
        const { policy, premium } = await this.checked(await tx.policy(input.policyId, input.actor), input.actor);
        if (policy.status === 'refunding') return null;
        if (policy.status === 'refunded') return reject('signature_failed');
        if (policy.status === 'issued') {
          const result = view(policy); await tx.finishCommand(input.actor.clientId, commandKey, result); return result;
        }
        if (policy.status === 'pending') {
          if (!premium || premium.id !== payment.id) return reject('integrity_violation');
          const confirmedPayment: Payment = { ...premium, status: 'confirmed', providerReference: settled.reference };
          await tx.confirmPremium(policy, confirmedPayment, traceId,
            this.decision('premium.confirmed', traceId, policy, 'confirmed', { payment: confirmedPayment, sources: settled.sources }));
        }
        return null;
      });
      if (completed) return { status: 'ok', replayed: true, policy: completed };
      const expiredBeforeSignature = this.deps.now().getTime() >= Date.parse(plan.policy.offer.expiresAt);
      const signature = expiredBeforeSignature ? { status: 'failed' as const } : await this.deps.signatures.sign(input.policyId, input.documentHash);
      const signatureSources: FinancialSource[] = expiredBeforeSignature ? [] : [{ source: 'synthetic-signature-v1', capturedAt: this.deps.now().toISOString(),
        quality: 'synthetic_result', degraded: false, operation: 'sign', result: signature.status }];
      if (signature.status === 'failed' || this.deps.now().getTime() >= Date.parse(plan.policy.offer.expiresAt) || !HEX.test(signature.receipt)
        || !(await this.deps.integrity.verify(JSON.stringify(['mock-signature-v1', input.policyId, input.documentHash]), signature.receipt))) {
        return refund(expiredBeforeSignature || this.deps.now().getTime() >= Date.parse(plan.policy.offer.expiresAt) ? (expiredBeforeSignature ? 'expired_before_sign' : 'expired_after_sign')
          : signature.status === 'failed' ? 'signature_refused' : 'signature_invalid', signatureSources);
      }
      const final = await this.deps.store.transaction(async tx => {
        const { policy, premium } = await this.checked(await tx.policy(input.policyId, input.actor), input.actor);
        if (policy.status === 'refunded' || policy.status === 'refunding') return reject('signature_failed');
        if (policy.status === 'issued') {
          const result = view(policy);
          await tx.finishCommand(input.actor.clientId, commandKey, result);
          return { status: 'ok' as const, replayed: plan.replayed, policy: result };
        }
        if (policy.status !== 'charged') throw new Error('financial_charge_missing');
        if (!premium) throw new Error('financial_intent_missing');
        const signedAt = this.deps.now().toISOString();
        if (Date.parse(signedAt) >= Date.parse(policy.offer.expiresAt)) {
          await tx.setPolicyStatus(policy.id, 'refunding');
          await tx.audit('premium.refund_requested', policy.id, traceId, 'refunding', policy.clientId,
            this.decision('premium.refund_requested', traceId, policy, 'refunding', { payment: premium,
              refundReason: 'expired_during_final_transaction', sources: signatureSources }));
          return null;
        }
        const timeSeal = await this.deps.integrity.digest(issuanceTimeContent(policy.id, input.documentHash, signedAt));
        const issuance = { documentHash: input.documentHash, receipt: signature.receipt, signedAt, timeSeal };
        const result = view({ ...policy, status: 'issued' });
        const stored = await tx.completeIssuance({ policy, signature: issuance, commandKey, result, traceId,
          capture: this.decision('policy.issued', traceId, policy, 'issued', { payment: premium, sources: signatureSources,
            issuance: { signedAt, documentHash: input.documentHash } }) });
        // The transaction commits only after the stored evidence matches the reviewed document and provider receipt.
        if (!stored || stored.documentHash !== issuance.documentHash || stored.receipt !== issuance.receipt
          || stored.signedAt !== signedAt || stored.timeSeal !== timeSeal) throw new Error('financial_issuance_evidence_missing');
        return { status: 'ok' as const, replayed: plan.replayed, policy: result };
      });
      return final ?? refund();
    });
  }

  private async checkPayment(payment: Payment, policy: StoredPolicy): Promise<void> {
    const amount = payment.operation === 'premium' ? policy.premium
      : policy.offer.coverage.kind === 'flight_delay' ? policy.offer.coverage.payoutAmount : null;
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

  consumeParametricEvent(input: unknown, trace: string): Promise<FinancialResult> {
    return this.run(trace, async traceId => {
      if (!isParametricEnvelope(input, this.deps.environment) || Date.parse(input.occurredAt) > this.deps.now().getTime() + 60000
        || !(await this.deps.integrity.verify(eventContent(input), input.signature))) return reject('invalid_event', 400);
      const hash = await this.deps.integrity.digest(eventContent(input));
      const source = financialEventSource(input, this.deps.now().toISOString());
      const plan = await this.deps.store.transaction(async tx => {
        const { policy, signature } = await this.checked(await tx.policy(input.payload.policyId));
        const previous = await tx.inbox(input.eventId, 'policy.parametric.v1');
        if (previous && (previous.hash !== hash || previous.policyId !== policy.id)) return reject('event_conflict');
        if (policy.status !== 'issued') return reject('policy_not_active');
        const coverage = policy.offer.coverage;
        if (coverage.kind !== 'flight_delay' || coverage.flightReference !== input.payload.flightReference
          || input.payload.delayMinutes < coverage.thresholdMinutes || !signature
          || !eventWithinIssuedCoverage(input.occurredAt, signature.signedAt, policy.effectiveFrom, policy.effectiveUntil)) return reject('event_not_covered');
        let payment = await tx.payment(policy.id, 'indemnity');
        if (!previous && payment) return reject('event_conflict');
        if (!payment) {
          payment = { id: this.deps.newId(), policyId: policy.id, operation: 'indemnity', amount: coverage.payoutAmount,
            currency: 'COP', key: 'parametric-once', hash: '', status: 'pending', providerReference: null };
          payment.hash = await this.deps.integrity.digest(paymentContent(payment));
          await tx.createPayment(payment, traceId, { id: this.deps.newId(), indemnityId: this.deps.newId(), occurredAt: input.occurredAt });
          await tx.recordInbox(input.eventId, 'policy.parametric.v1', hash, policy.id, input.eventType, traceId);
          await tx.audit('parametric.accepted', policy.id, traceId, 'accepted', 'synthetic-oracle-v1',
            this.decision('parametric.accepted', traceId, policy, 'accepted', { payment, sources: [source],
              issuance: { signedAt: signature.signedAt, documentHash: signature.documentHash },
            event: { eventId: input.eventId, eventType: input.eventType, environment: input.environment, occurredAt: input.occurredAt, delayMinutes: input.payload.delayMinutes } }));
        }
        await this.checkPayment(payment, policy);
        return { policy, payment, replayed: !!previous };
      });
      const settled = await this.settle(plan.payment);
      if (settled.status === 'uncertain') throw new Error('financial_provider_uncertain');
      if (settled.status === 'declined') return reject('payment_declined');
      await this.deps.store.transaction(async tx => {
        const { policy, signature } = await this.checked(await tx.policy(plan.policy.id));
        const payment = await tx.payment(policy.id, 'indemnity');
        if (!payment) throw new Error('financial_intent_missing');
        await this.checkPayment(payment, policy);
        if (payment.status !== 'confirmed') {
          await tx.setPaymentStatus(payment.id, 'confirmed', settled.reference);
          if (!signature) throw new Error('financial_issuance_evidence_missing');
          await tx.audit('indemnity.confirmed', policy.id, traceId, 'confirmed', 'synthetic-oracle-v1',
            this.decision('indemnity.confirmed', traceId, policy, 'confirmed', { payment: { ...payment, status: 'confirmed', providerReference: settled.reference }, sources: [source, ...settled.sources],
              issuance: { signedAt: signature.signedAt, documentHash: signature.documentHash },
            event: { eventId: input.eventId, eventType: input.eventType, environment: input.environment, occurredAt: input.occurredAt, delayMinutes: input.payload.delayMinutes } }));
        }
      });
      return { status: 'ok', replayed: plan.replayed, policy: view(plan.policy) };
    });
  }
}

export { FINANCIAL_RULE };
