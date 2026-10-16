import { canonical, eventContent, eventWithinIssuedCoverage, FINANCIAL_RULE, HEX, InvalidFinancialRecord, isAcceptedOffer, isOfferEnvelope, isParametricEnvelope, issuanceTimeContent, iso, offerContent, paymentContent, policyDocument, UUID } from '../domain/financial';
import type { FinancialActor, FinancialErrorCode, FinancialResult, PolicyView } from '../domain/financial';
import type { FinancialDependencies, FinancialTransaction, Payment, StoredPolicy } from './ports/financial';

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
          await this.deps.store.rejection(this.deps.newId(), traceId, error.code);
          return { status: 'denied', error: error.code, httpStatus: error.httpStatus, traceId };
        } catch { /* A rejection without its required audit must not claim durable completion. */ }
      }
      return { status: 'unavailable', error: 'financial_unavailable', httpStatus: 503, traceId };
    }
  }

  private async checked(tx: FinancialTransaction, policy: StoredPolicy | null, actor?: FinancialActor): Promise<StoredPolicy> {
    if (!policy) return reject('not_found', 404);
    if (actor && (policy.clientId !== actor.clientId || policy.subjectToken !== actor.subjectToken)) return reject('not_found', 404);
    const offer = policy.offer;
    if (!isAcceptedOffer(offer) || !(await this.deps.integrity.verify(offerContent(offer), policy.termsHash))
      || policy.clientId !== offer.clientId || policy.subjectToken !== offer.subjectToken || policy.offerId !== offer.offerId
      || policy.offerVersion !== offer.offerVersion || policy.premium !== offer.premium || policy.currency !== offer.currency
      || canonical(policy.coverageSnapshot) !== canonical(offer.coverage)
      || Date.parse(policy.effectiveFrom) !== Date.parse(offer.effectiveFrom) || Date.parse(policy.effectiveUntil) !== Date.parse(offer.effectiveUntil)
      || policy.document !== policyDocument(policy.id, offer) || !(await this.deps.integrity.verify(policy.document, policy.documentHash))) return reject('integrity_violation');
    if (policy.status === 'issued') {
      const signature = await tx.signature(policy.id);
      const premium = await tx.payment(policy.id, 'premium');
      if (!signature || signature.documentHash !== policy.documentHash
        || !(await this.deps.integrity.verify(JSON.stringify(['mock-signature-v1', policy.id, policy.documentHash]), signature.receipt))
        || !iso(signature.signedAt) || !signature.timeSeal || !eventWithinIssuedCoverage(signature.signedAt, signature.signedAt, policy.effectiveFrom, policy.effectiveUntil)
        || !(await this.deps.integrity.verify(issuanceTimeContent(policy.id, policy.documentHash, signature.signedAt), signature.timeSeal))
        || !premium || premium.status !== 'confirmed') return reject('integrity_violation');
      await this.checkPayment(premium, policy);
    }
    return policy;
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
      return this.deps.store.transaction(async tx => {
        const inbox = await tx.inbox(input.eventId, 'policy.offer-accepted.v1');
        if (inbox) {
          if (inbox.hash !== hash || !inbox.policyId) return reject('event_conflict');
          const policy = await this.checked(tx, await tx.policy(inbox.policyId));
          return { status: 'ok', replayed: true, policy: view(policy) };
        }
        if (await tx.acceptedPolicy(input.payload.acceptanceId) || await tx.offeredPolicy(input.payload.offerId, input.payload.offerVersion)) return reject('event_conflict');
        const offer = input.payload;
        const policy: StoredPolicy = { id, clientId: offer.clientId, subjectToken: offer.subjectToken, status: 'pending',
          offer, termsHash, document, documentHash, premium: offer.premium, currency: offer.currency,
          offerId: offer.offerId, offerVersion: offer.offerVersion, effectiveFrom: offer.effectiveFrom, effectiveUntil: offer.effectiveUntil, coverageSnapshot: offer.coverage };
        await tx.createPolicy(policy, input.eventId, traceId);
        await tx.recordInbox(input.eventId, 'policy.offer-accepted.v1', hash, id, input.eventType, traceId);
        await tx.audit('offer.accepted', id, traceId, 'accepted', offer.clientId);
        return { status: 'ok', replayed: false, policy: view(policy) };
      });
    });
  }

  get(input: { actor: FinancialActor; policyId: string; traceId: string }): Promise<FinancialResult> {
    return this.run(input.traceId, async () => {
      if (!validActor(input.actor) || !UUID.test(input.policyId)) return reject('invalid_request', 400);
      return this.deps.store.transaction(async tx => ({ status: 'ok', replayed: false,
        policy: view(await this.checked(tx, await tx.policy(input.policyId), input.actor)) }));
    });
  }

  getByAcceptance(input: { actor: FinancialActor; acceptanceId: string; traceId: string }): Promise<FinancialResult> {
    return this.run(input.traceId, async () => {
      if (!validActor(input.actor) || !UUID.test(input.acceptanceId)) return reject('invalid_request', 400);
      return this.deps.store.transaction(async tx => ({ status: 'ok', replayed: false,
        policy: view(await this.checked(tx, await tx.acceptedPolicy(input.acceptanceId), input.actor)) }));
    });
  }

  issue(input: { actor: FinancialActor; policyId: string; idempotencyKey: string; documentHash: string; traceId: string }): Promise<FinancialResult> {
    return this.run(input.traceId, async traceId => {
      if (!validActor(input.actor) || !UUID.test(input.policyId) || typeof input.idempotencyKey !== 'string'
        || !/^[\x21-\x7e]{1,128}$/.test(input.idempotencyKey) || !HEX.test(input.documentHash)) return reject('invalid_request', 400);
      const requestHash = await this.deps.integrity.digest(JSON.stringify(['issue.v1', input.actor.clientId, input.policyId, input.documentHash]));
      const commandKey = await this.deps.integrity.digest(JSON.stringify(['command-key.v1', input.actor.clientId, input.idempotencyKey]));
      const plan = await this.deps.store.transaction(async tx => {
        const policy = await this.checked(tx, await tx.policy(input.policyId), input.actor);
        if (policy.documentHash !== input.documentHash) return reject('document_mismatch');
        const previous = await tx.command(input.actor.clientId, commandKey);
        if (previous && (previous.requestHash !== requestHash || previous.policyId !== policy.id)) return reject('idempotency_conflict');
        if (previous?.result) {
          if (policy.status !== 'issued' || canonical(previous.result) !== canonical(view(policy))) return reject('integrity_violation');
          return { policy, payment: null, replayed: true, completed: view(policy) };
        }
        if (policy.status === 'refunded') return reject('signature_failed');
        if (!previous) await tx.createCommand(input.actor.clientId, commandKey, policy.id, requestHash);
        if (policy.status === 'issued') {
          const result = view(policy); await tx.finishCommand(input.actor.clientId, commandKey, result);
          return { policy, payment: null, replayed: !!previous, completed: result };
        }
        let payment = await tx.payment(policy.id, 'premium');
        if (!payment) {
          if (this.deps.now().getTime() >= Date.parse(policy.offer.expiresAt)) return reject('offer_invalid');
          payment = { id: this.deps.newId(), policyId: policy.id, operation: 'premium', amount: policy.premium,
            currency: 'COP', key: 'initial-premium', hash: '', status: 'pending', providerReference: null };
          payment.hash = await this.deps.integrity.digest(paymentContent(payment));
          await tx.createPayment(payment, traceId);
        }
        await this.checkPayment(payment, policy);
        if (payment.status === 'declined') return reject('payment_declined');
        return { policy, payment, replayed: !!previous, completed: null };
      });
      if (plan.completed) return { status: 'ok', replayed: plan.replayed, policy: plan.completed };
      if (!plan.payment) throw new Error('financial_plan_unavailable');
      const payment = plan.payment;
      const refund = async (): Promise<FinancialResult> => {
        const completed = await this.deps.store.transaction(async tx => {
          const policy = await this.checked(tx, await tx.policy(input.policyId), input.actor);
          if (policy.status === 'issued') {
            const result = view(policy); await tx.finishCommand(input.actor.clientId, commandKey, result); return result;
          }
          if (policy.status === 'refunded') return reject('signature_failed');
          if (policy.status !== 'charged' && policy.status !== 'refunding') throw new Error('financial_refund_state_invalid');
          if (policy.status !== 'refunding') {
            await tx.setPolicyStatus(policy.id, 'refunding');
            await tx.audit('premium.refund_requested', policy.id, traceId, 'refunding', policy.clientId);
          }
          return null;
        });
        if (completed) return { status: 'ok', replayed: true, policy: completed };
        const refunded = await this.deps.payments.refund(payment);
        if (refunded.status !== 'refunded') throw new Error('financial_refund_uncertain');
        await this.deps.store.transaction(async tx => {
          const policy = await this.checked(tx, await tx.policy(input.policyId), input.actor);
          if (policy.status === 'refunded') return;
          if (policy.status !== 'refunding') throw new Error('financial_refund_state_invalid');
          await tx.setPaymentStatus(payment.id, 'refunded', refunded.reference);
          await tx.setPolicyStatus(policy.id, 'refunded');
          await tx.audit('premium.refunded', policy.id, traceId, 'refunded', policy.clientId);
        });
        return reject('signature_failed');
      };
      if (plan.policy.status === 'refunding') return refund();
      const settled = await this.settle(payment, this.deps.now().getTime() < Date.parse(plan.policy.offer.expiresAt));
      if (settled.status === 'uncertain') throw new Error('financial_provider_uncertain');
      if (settled.status === 'declined') {
        const refundInProgress = await this.deps.store.transaction(async tx => {
          const policy = await this.checked(tx, await tx.policy(input.policyId), input.actor);
          if (policy.status === 'refunding') return true;
          if (policy.status === 'refunded') return reject('signature_failed');
          await tx.setPaymentStatus(payment.id, 'declined', settled.reference);
          return false;
        });
        if (refundInProgress) return refund();
        return reject('payment_declined');
      }
      const completed = await this.deps.store.transaction(async tx => {
        const policy = await this.checked(tx, await tx.policy(input.policyId), input.actor);
        if (policy.status === 'refunding') return null;
        if (policy.status === 'refunded') return reject('signature_failed');
        if (policy.status === 'issued') {
          const result = view(policy); await tx.finishCommand(input.actor.clientId, commandKey, result); return result;
        }
        if (policy.status === 'pending') {
          await tx.setPaymentStatus(payment.id, 'confirmed', settled.reference);
          await tx.setPolicyStatus(policy.id, 'charged');
          await tx.audit('premium.confirmed', policy.id, traceId, 'confirmed', policy.clientId);
        }
        return null;
      });
      if (completed) return { status: 'ok', replayed: true, policy: completed };
      const signature = this.deps.now().getTime() >= Date.parse(plan.policy.offer.expiresAt)
        ? { status: 'failed' as const } : await this.deps.signatures.sign(input.policyId, input.documentHash);
      if (signature.status === 'failed' || this.deps.now().getTime() >= Date.parse(plan.policy.offer.expiresAt) || !HEX.test(signature.receipt)
        || !(await this.deps.integrity.verify(JSON.stringify(['mock-signature-v1', input.policyId, input.documentHash]), signature.receipt))) {
        return refund();
      }
      return this.deps.store.transaction(async tx => {
        const policy = await this.checked(tx, await tx.policy(input.policyId), input.actor);
        if (policy.status === 'refunded' || policy.status === 'refunding') return reject('signature_failed');
        if (policy.status !== 'issued') {
          if (policy.status !== 'charged') throw new Error('financial_charge_missing');
          const existing = await tx.signature(policy.id);
          if (existing && existing.documentHash !== input.documentHash) return reject('document_mismatch');
          if (!existing) {
            const signedAt = this.deps.now().toISOString();
            await tx.recordSignature(policy.id, input.documentHash, signature.receipt, signedAt,
              await this.deps.integrity.digest(issuanceTimeContent(policy.id, input.documentHash, signedAt)));
          }
          await tx.setPolicyStatus(policy.id, 'issued');
          await tx.audit('policy.issued', policy.id, traceId, 'issued', policy.clientId);
          policy.status = 'issued';
        }
        const result = view(policy);
        await tx.finishCommand(input.actor.clientId, commandKey, result);
        return { status: 'ok', replayed: plan.replayed, policy: result };
      });
    });
  }

  private async checkPayment(payment: Payment, policy: StoredPolicy): Promise<void> {
    const amount = payment.operation === 'premium' ? policy.premium
      : policy.offer.coverage.kind === 'flight_delay' ? policy.offer.coverage.payoutAmount : null;
    if (!amount || !UUID.test(payment.id) || payment.policyId !== policy.id || payment.amount !== amount || payment.currency !== 'COP'
      || payment.key !== (payment.operation === 'premium' ? 'initial-premium' : 'parametric-once')
      || !(await this.deps.integrity.verify(paymentContent(payment), payment.hash))) return reject('integrity_violation');
  }

  private async settle(payment: Payment, allowNew = true) {
    const known = await this.deps.payments.lookup(payment);
    if (known.status !== 'unknown') return known;
    if (!allowNew) return reject('offer_invalid');
    return this.deps.payments.settle(payment);
  }

  consumeParametricEvent(input: unknown, trace: string): Promise<FinancialResult> {
    return this.run(trace, async traceId => {
      if (!isParametricEnvelope(input, this.deps.environment) || Date.parse(input.occurredAt) > this.deps.now().getTime() + 60000
        || !(await this.deps.integrity.verify(eventContent(input), input.signature))) return reject('invalid_event', 400);
      const hash = await this.deps.integrity.digest(eventContent(input));
      const plan = await this.deps.store.transaction(async tx => {
        const policy = await this.checked(tx, await tx.policy(input.payload.policyId));
        const previous = await tx.inbox(input.eventId, 'policy.parametric.v1');
        if (previous && (previous.hash !== hash || previous.policyId !== policy.id)) return reject('event_conflict');
        if (policy.status !== 'issued') return reject('policy_not_active');
        const signature = await tx.signature(policy.id);
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
          await tx.audit('parametric.accepted', policy.id, traceId, 'accepted', 'synthetic-oracle-v1');
        }
        await this.checkPayment(payment, policy);
        return { policy, payment, replayed: !!previous };
      });
      const settled = await this.settle(plan.payment);
      if (settled.status === 'uncertain') throw new Error('financial_provider_uncertain');
      if (settled.status === 'declined') return reject('payment_declined');
      await this.deps.store.transaction(async tx => {
        const policy = await this.checked(tx, await tx.policy(plan.policy.id));
        const payment = await tx.payment(policy.id, 'indemnity');
        if (!payment) throw new Error('financial_intent_missing');
        await this.checkPayment(payment, policy);
        if (payment.status !== 'confirmed') {
          await tx.setPaymentStatus(payment.id, 'confirmed', settled.reference);
          await tx.audit('indemnity.confirmed', policy.id, traceId, 'confirmed', 'synthetic-oracle-v1');
        }
      });
      return { status: 'ok', replayed: plan.replayed, policy: view(plan.policy) };
    });
  }
}

export { FINANCIAL_RULE };
