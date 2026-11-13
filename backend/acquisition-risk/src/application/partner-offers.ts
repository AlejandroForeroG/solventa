import type { DependencyTimings } from './dependency-timings';
import type { CreateQuote } from './create-quote';
import type { OfferService } from './offer-service';
import type { PartnerOfferAccess, PartnerOfferDenial } from './ports/partner-offer-access';
import type { Protector } from './ports/platform';
import type { FieldError } from '../domain/quote';
import { partnerOfferView, type PartnerOfferView } from '../domain/partner-offer';

export type PartnerOfferInput = { token: string; body: unknown; idempotencyKey: string | null; traceId: string; timings?: DependencyTimings };
export type PartnerOfferResult =
  | { status: 'created' | 'replayed'; offer: PartnerOfferView }
  | { status: 'denied'; error: PartnerOfferDenial; retryAfter?: number; httpStatus: 401 | 403 | 429 | 503 }
  | { status: 'invalid'; errors: FieldError[] }
  | { status: 'idempotency_conflict' | 'declined' | 'conflict' | 'unavailable' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// The partner names an authorization and the credit; Identity names the customer. The offer then follows the same
// quote, consent-bound profiling and degradation rules as the customer's own web journey.
export class PartnerOffers {
  constructor(private readonly deps: { access: PartnerOfferAccess; quotes: Pick<CreateQuote, 'createFor'>; offers: Pick<OfferService, 'create' | 'explanation'>; protector: Pick<Protector, 'partnerKey'> }) {}

  async create(input: PartnerOfferInput): Promise<PartnerOfferResult> {
    if (!isObject(input.body) || typeof input.body.authorizationId !== 'string' || !UUID.test(input.body.authorizationId)) {
      return { status: 'invalid', errors: [{ field: 'authorizationId', code: input.body && isObject(input.body) && input.body.authorizationId !== undefined ? 'invalid_format' : 'required' }] };
    }
    const { authorizationId, ...quoteBody } = input.body;
    const id = authorizationId.toLowerCase();
    const run = <T>(name: string, call: () => Promise<T>) => input.timings ? input.timings.measure(name, call) : call();
    const access = await run('identity_access', () => this.deps.access.authorize({ token: input.token, authorizationId: id, traceId: input.traceId }));
    if (!access.allowed) {
      return access.status === 400 ? { status: 'denied', error: 'access_unavailable', httpStatus: 503 } : { status: 'denied', error: access.error, httpStatus: access.status, ...(access.retryAfter === undefined ? {} : { retryAfter: access.retryAfter }) };
    }
    const key = input.idempotencyKey;
    if (key === null || key.length < 1) return { status: 'invalid', errors: [{ field: 'Idempotency-Key', code: 'required' }] };
    if (key.length > 128) return { status: 'invalid', errors: [{ field: 'Idempotency-Key', code: 'invalid_format' }] };

    const actor = access.customer;
    const scopedKey = await this.deps.protector.partnerKey(access.partnerId, id, key);
    const quote = await this.deps.quotes.createFor({ kind: 'user', ...actor }, { idempotencyKey: scopedKey, body: quoteBody, traceId: input.traceId });
    if (quote.status === 'invalid') return { status: 'invalid', errors: quote.errors };
    if (quote.status === 'idempotency_conflict') return { status: 'idempotency_conflict' };
    // The offer lasts no longer than the customer's consent or the authorization they gave this partner.
    const expiresAt = Date.parse(access.consent.expiresAt) <= Date.parse(access.authorizationExpiresAt) ? access.consent.expiresAt : access.authorizationExpiresAt;
    const offer = await this.deps.offers.create({ actor, quoteId: quote.quote.quoteId, idempotencyKey: scopedKey, traceId: input.traceId, timings: input.timings,
      authorization: { ...access.consent, expiresAt }, channel: { kind: 'partner', partnerId: access.partnerId, authorizationId: id } });
    if (offer.status === 'denied') return { status: 'denied', error: 'consent_required', httpStatus: 403 };
    if (offer.status === 'declined' || offer.status === 'unavailable') return { status: offer.status };
    if (offer.status !== 'created' && offer.status !== 'replayed') return { status: 'conflict' };
    const capture = await this.deps.offers.explanation(actor, offer.offer.offerId);
    return capture ? { status: offer.status, offer: partnerOfferView(offer.offer, capture) } : { status: 'unavailable' };
  }
}
