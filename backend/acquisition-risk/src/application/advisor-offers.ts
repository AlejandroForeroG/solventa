import type { DependencyTimings } from './dependency-timings';
import type { CreateQuote } from './create-quote';
import type { OfferService } from './offer-service';
import type { AdvisorSaleAccess, AdvisorSaleDenial, AdvisorSessionCredential } from './ports/advisor-sale-access';
import { LeaseExpired } from './ports/lease';
import type { Clock, Protector } from './ports/platform';
import type { FieldError } from '../domain/quote';
import { partnerOfferView, type PartnerOfferView } from '../domain/partner-offer';

export type AdvisorOfferInput = { session: AdvisorSessionCredential; body: unknown; idempotencyKey: string | null; traceId: string; timings?: DependencyTimings };
export type AdvisorOfferResult =
  | { status: 'created' | 'replayed'; offer: PartnerOfferView }
  | { status: 'denied'; error: AdvisorSaleDenial; httpStatus: 401 | 403 | 503 }
  | { status: 'invalid'; errors: FieldError[] }
  | { status: 'idempotency_conflict' | 'declined' | 'conflict' | 'unavailable' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// The advisor names an authorization and the credit; Identity names the customer. The offer belongs to the customer and
// follows the same quote, consent-bound profiling and degradation rules as their own web journey. It is only prepared:
// accepting, paying and signing stay with the customer in their own session.
export class AdvisorOffers {
  constructor(private readonly deps: { access: AdvisorSaleAccess; quotes: Pick<CreateQuote, 'createFor'>; offers: Pick<OfferService, 'create' | 'explanation'>; protector: Pick<Protector, 'advisorKey'>; clock: Clock }) {}

  async create(input: AdvisorOfferInput): Promise<AdvisorOfferResult> {
    if (!isObject(input.body) || typeof input.body.authorizationId !== 'string' || !UUID.test(input.body.authorizationId)) {
      return { status: 'invalid', errors: [{ field: 'authorizationId', code: isObject(input.body) && input.body.authorizationId !== undefined ? 'invalid_format' : 'required' }] };
    }
    const { authorizationId, ...quoteBody } = input.body;
    const id = authorizationId.toLowerCase();
    const run = <T>(name: string, call: () => Promise<T>) => input.timings ? input.timings.measure(name, call) : call();
    const access = await run('identity_access', () => this.deps.access.authorize({ session: input.session, authorizationId: id, traceId: input.traceId }));
    if (!access.allowed) {
      return access.status === 400 ? { status: 'denied', error: 'access_unavailable', httpStatus: 503 } : { status: 'denied', error: access.error, httpStatus: access.status };
    }
    // The advisor's short permission is a deadline of its own for the whole operation: it is re-checked before every step and enforced where the
    // quote and the offer commit, and it is never used as the validity of the offer.
    const lease = Date.parse(access.leaseExpiresAt);
    const leaseOver = () => !(this.deps.clock.now().getTime() < lease);
    const expired: AdvisorOfferResult = { status: 'denied', error: 'access_unavailable', httpStatus: 503 };
    if (leaseOver()) return expired;
    const key = input.idempotencyKey;
    if (key === null || key.length < 1) return { status: 'invalid', errors: [{ field: 'Idempotency-Key', code: 'required' }] };
    if (key.length > 128) return { status: 'invalid', errors: [{ field: 'Idempotency-Key', code: 'invalid_format' }] };

    const actor = access.customer;
    const scopedKey = await this.deps.protector.advisorKey(access.advisorReference, id, key);
    let quote;
    try { quote = await this.deps.quotes.createFor({ kind: 'user', ...actor }, { idempotencyKey: scopedKey, body: quoteBody, traceId: input.traceId, deadline: access.leaseExpiresAt }); }
    catch (error) { if (error instanceof LeaseExpired) return expired; throw error; }
    if (leaseOver()) return expired;
    if (quote.status === 'invalid') return { status: 'invalid', errors: quote.errors };
    if (quote.status === 'idempotency_conflict') return { status: 'idempotency_conflict' };
    // The offer lasts no longer than the customer's consent or the authorization they gave this advisor.
    const expiresAt = Date.parse(access.consent.expiresAt) <= Date.parse(access.authorizationExpiresAt) ? access.consent.expiresAt : access.authorizationExpiresAt;
    let offer;
    try {
      offer = await this.deps.offers.create({ actor, quoteId: quote.quote.quoteId, idempotencyKey: scopedKey, traceId: input.traceId, timings: input.timings, deadline: access.leaseExpiresAt,
        authorization: { ...access.consent, expiresAt }, channel: { kind: 'advisor', advisorReference: access.advisorReference, authorizationId: id } });
    } catch (error) { if (error instanceof LeaseExpired) return expired; throw error; }
    // A refusal after the lease ended is the lease, not the customer's consent.
    if (leaseOver() && offer.status !== 'created' && offer.status !== 'replayed') return expired;
    if (offer.status === 'denied') return { status: 'denied', error: 'consent_required', httpStatus: 403 };
    if (offer.status === 'declined' || offer.status === 'unavailable') return { status: offer.status };
    if (offer.status !== 'created' && offer.status !== 'replayed') return { status: 'conflict' };
    const capture = await this.deps.offers.explanation(actor, offer.offer.offerId);
    // The write may already be durable, but nothing about it is handed to the advisor after the lease: a retry with the same key replays it.
    if (leaseOver()) return expired;
    return capture ? { status: offer.status, offer: partnerOfferView(offer.offer, capture) } : { status: 'unavailable' };
  }
}
