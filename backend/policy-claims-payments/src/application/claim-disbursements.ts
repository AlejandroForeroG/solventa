import { eventWithinIssuedCoverage, isAcceptedOffer, issuanceTimeContent, offerContent, paymentContent, UUID } from '../domain/financial';
import { amountWithinCoverage, disbursementKey, disbursementLimit, type DisbursementInput, type DisbursementView } from '../domain/claim-disbursement';
import type { ClaimDecisionActor } from './claim-decisions';
import type { FinancialIntegrity, Payment, PaymentGateway } from './ports/financial';
import type { DisbursementCapture, DisbursementContext, DisbursementDeadline, DisbursementStore } from './ports/claim-disbursement';
import type { ReportOwner } from './ports/claim-report';
import { isLifecycleChange, lifecycleContent } from '../domain/policy-lifecycle';

export type DisbursementRequest = { status: 'ok'; payment: DisbursementView; replayed: boolean }
  | { status: 'not_found' | 'conflict' | 'invalid_amount' };
export type DisbursementOutcome = { paymentId: string; status: 'confirmed' | 'declined' | 'unchanged' | 'unavailable'; error?: string };

export class ClaimDisbursements {
  constructor(private readonly store: DisbursementStore, private readonly gateway: PaymentGateway, private readonly integrity: FinancialIntegrity,
    private readonly deadline: DisbursementDeadline, private readonly clock: { now(): Date; newId(): string }, private readonly enabled: boolean) {}

  async owned(owner: ReportOwner, traceId: string, cursor?: string) {
    if (!this.enabled) throw Error('claim_disbursement_unavailable');
    if (!UUID.test(owner.clientId) || !UUID.test(owner.subjectToken) || !UUID.test(traceId) || (cursor && !UUID.test(cursor))) throw Error('invalid_claim_owner');
    return this.store.transaction(async tx => {
      const contexts = await tx.owned(owner, traceId, cursor);
      const items: { claimId: string; claimNumber: string; updatedAt: string; payment: DisbursementView }[] = [];
      for (const context of contexts.slice(0, 6)) {
        if (context.ownerSubjectToken !== owner.subjectToken || context.offer.clientId !== owner.clientId || !context.payment
          || !/^SIN-\d{4}-\d{5}$/.test(context.claimNumber) || !Number.isFinite(Date.parse(context.updatedAt))) throw Error('claim_disbursement_integrity');
        await this.checked(context);
        items.push({ claimId: context.claimId, claimNumber: context.claimNumber, updatedAt: context.updatedAt, payment: this.view(context.payment) });
      }
      return { items, next: contexts.length > 6 ? items.at(-1)?.claimId ?? null : null };
    });
  }

  async read(claimId: string, actor: ClaimDecisionActor): Promise<DisbursementView | null> {
    if (!this.enabled) throw Error('claim_disbursement_unavailable');
    this.active(actor);
    const result = await this.store.transaction(async tx => {
      const context = await tx.authorized(claimId, actor);
      if (!context) return null;
      await this.checked(context);
      return context.payment ? this.view(context.payment) : null;
    }, actor);
    this.active(actor);
    return result;
  }

  async request(claimId: string, input: DisbursementInput, actor: ClaimDecisionActor): Promise<DisbursementRequest> {
    if (!this.enabled) throw Error('claim_disbursement_unavailable');
    this.active(actor);
    const result = await this.store.transaction<DisbursementRequest>(async tx => {
      const context = await tx.authorized(claimId, actor);
      if (!context) return { status: 'not_found' };
      await this.checked(context);
      // Parametric coverages retain their automatic, fixed-payment engine and cannot acquire a second manual payout.
      if (context.offer.coverage.kind !== 'mortgage_life') return { status: 'conflict' };
      if (context.payment) return context.payment.amount === input.amount
        ? { status: 'ok', payment: this.view(context.payment), replayed: true } : { status: 'conflict' };
      if (context.lifecycle && Date.parse(context.occurredAt) >= Date.parse(context.lifecycle.at)) return { status: 'conflict' };
      if (!amountWithinCoverage(input.amount, disbursementLimit(context.offer), context.reservedAmount)) return { status: 'invalid_amount' };
      if (context.state !== 'approved') return { status: 'conflict' };
      const payment: Payment = { id: this.clock.newId(), policyId: context.policyId, operation: 'indemnity', amount: input.amount,
        currency: 'COP', key: disbursementKey(context.decisionId), hash: '', status: 'pending', providerReference: null };
      payment.hash = await this.integrity.digest(paymentContent(payment));
      this.active(actor);
      await tx.create(context, payment, this.clock.newId(), actor, this.capture(context, payment, actor.traceId, 'pending'));
      return { status: 'ok', payment: this.view(payment), replayed: false };
    }, actor);
    this.active(actor);
    return result;
  }

  async recoverPayment(paymentId: string): Promise<DisbursementOutcome> {
    if (!this.enabled) return { paymentId, status: 'unavailable' };
    try {
      const context = await this.store.transaction(tx => tx.pending(paymentId));
      if (!context) return { paymentId, status: 'unchanged' };
      await this.checked(context);
      const payment = context.payment;
      if (!payment) throw Error('claim_payment_intent_missing');
      if (payment.status !== 'pending') return { paymentId, status: 'unchanged' };
      // Lookup first after every restart. A lost provider response must never initiate a different payment.
      const known = await this.deadline.race(this.gateway.lookup(payment), 700, 'lookup');
      if (known === 'expired') throw Error('claim_payment_lookup_timeout');
      if (known.status === 'refunded') throw Error('claim_indemnity_refunded');
      const result = known.status === 'unknown' ? await this.deadline.race(this.gateway.settle(payment), 700, 'settle') : known;
      if (result === 'expired' || result.status === 'uncertain') throw Error('claim_payment_uncertain');
      if ((result.status !== 'confirmed' && result.status !== 'declined')
        || (result.status === 'confirmed' && result.reference !== 'MOCK-' + payment.id)
        || (result.status === 'declined' && result.reference !== null)) throw Error('claim_payment_invalid_response');
      const traceId = this.clock.newId();
      const status = result.status;
      const committed = await this.store.transaction(async tx => {
        const current = await tx.pending(paymentId);
        if (!current) return false;
        await this.checked(current);
        if (!current.payment || current.payment.hash !== payment.hash) throw Error('claim_payment_intent_changed');
        if (current.payment.status !== 'pending') return false;
        await tx.finish(current, status, result.reference, traceId, this.capture(current, current.payment, traceId, status));
        return true;
      });
      return { paymentId, status: committed ? status : 'unchanged' };
    } catch (error) {
      return { paymentId, status: 'unavailable', error: error instanceof Error && /^claim_[a-z_]{3,64}$/.test(error.message)
        ? error.message : 'claim_disbursement_unavailable' };
    }
  }

  async reconcile(limit = 25): Promise<DisbursementOutcome[]> {
    if (!this.enabled) return [];
    const results: DisbursementOutcome[] = [];
    for (const paymentId of await this.store.candidates(Math.max(1, Math.min(25, limit)))) results.push(await this.recoverPayment(paymentId));
    return results;
  }

  private async checked(context: DisbursementContext) {
    const offer = context.offer;
    if (context.lifecycle && (!isLifecycleChange(context.lifecycle) || context.lifecycle.policyId !== context.policyId
      || context.lifecycle.sourceDocumentHash !== context.documentHash
      || !(await this.integrity.verify(lifecycleContent(context.lifecycle), context.lifecycle.documentHash))))
      throw Error('claim_disbursement_integrity');
    if (!UUID.test(context.claimId) || !UUID.test(context.decisionId) || !UUID.test(context.policyId)
      || !isAcceptedOffer(offer) || context.policyStatus !== 'issued' || !['approved', 'paid'].includes(context.state)
      || context.ownerSubjectToken !== offer.subjectToken || context.premiumStatus !== 'confirmed'
      || !eventWithinIssuedCoverage(context.occurredAt, context.issuedAt, offer.effectiveFrom, offer.effectiveUntil)
      || !(await this.integrity.verify(offerContent(offer), context.termsHash))
      || !(await this.integrity.verify(JSON.stringify(['mock-signature-v1', context.policyId, context.documentHash]), context.signatureReceipt))
      || !(await this.integrity.verify(issuanceTimeContent(context.policyId, context.documentHash, context.issuedAt), context.timeSeal)))
      throw Error('claim_disbursement_integrity');
    const payment = context.payment;
    if (payment && (offer.coverage.kind !== 'mortgage_life' || !UUID.test(payment.id) || payment.policyId !== context.policyId || payment.operation !== 'indemnity'
      || payment.key !== disbursementKey(context.decisionId) || payment.amount !== context.indemnityAmount || !context.indemnityId
      || !amountWithinCoverage(payment.amount, disbursementLimit(offer), payment.status === 'declined' ? '0.0000' : context.reservedAmount) || payment.currency !== 'COP'
      || !['pending', 'confirmed', 'declined'].includes(payment.status)
      || (payment.status === 'pending' && payment.providerReference !== null)
      || (payment.status === 'declined' && payment.providerReference !== null)
      || (payment.status === 'confirmed' && (payment.providerReference !== 'MOCK-' + payment.id || context.state !== 'paid'))
      || (payment.status !== 'confirmed' && context.state !== 'approved')
      || !(await this.integrity.verify(paymentContent(payment), payment.hash)))) throw Error('claim_payment_integrity');
  }

  private active(actor: ClaimDecisionActor) {
    if (!UUID.test(actor.clientId) || !actor.subjectToken || !UUID.test(actor.subjectToken) || !UUID.test(actor.traceId)
      || !(Date.parse(actor.expiresAt) > this.clock.now().getTime())) throw Error('claims_authorization_expired');
  }

  private view(payment: Payment): DisbursementView {
    if (payment.status === 'refunded') throw Error('claim_indemnity_refunded');
    return { paymentId: payment.id, amount: payment.amount, currency: 'COP', status: payment.status, reference: payment.providerReference, simulated: true };
  }

  private capture(context: DisbursementContext, payment: Payment, traceId: string, outcome: string): DisbursementCapture {
    return { schemaVersion: 1, contractVersion: 'v1', correlationId: traceId,
      inputs: { claimId: context.claimId, decisionId: context.decisionId, policyId: context.policyId, paymentId: payment.id,
        amount: payment.amount, currency: payment.currency, coverageLimit: disbursementLimit(context.offer), reservedAmount: context.reservedAmount,
        policyTermsHash: context.termsHash, policyLifecycle: context.lifecycle, occurredAt: context.occurredAt, issuedAt: context.issuedAt, paymentHash: payment.hash },
      sources: outcome === 'pending' ? [] : [{ source: 'synthetic-payment-gateway-v1', capturedAt: this.clock.now().toISOString() }],
      consent: { status: 'not_required' }, rule: { id: 'approved-claim-disbursement', version: '2' }, outcome };
  }
}
