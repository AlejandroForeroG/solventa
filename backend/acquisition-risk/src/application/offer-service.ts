import { offerTerms, underwrite, type OfferActor, type OfferAuthorization } from '../domain/offer';
import { SIGNAL_SCOPES } from '../domain/signal';
import type { Clock } from './ports/platform';
import type { FlightSchedule, OfferIntegrity, OfferStore, StoredOffer } from './ports/offer-store';
import type { SignalProvider } from './ports/signal-sources';

type Command = { actor: OfferActor; idempotencyKey: string; traceId: string; authorization: OfferAuthorization };
const validKey = (key: string) => typeof key === 'string' && key.length > 0 && key.length <= 128;

export class OfferService {
  constructor(private readonly deps: { store: OfferStore; provider: SignalProvider; flights: FlightSchedule; integrity: OfferIntegrity; clock: Clock; environment: string; enabled: boolean }) {}
  private authorized(input: Command): boolean {
    return this.deps.enabled && input.authorization.textVersion > 0 && !!input.authorization.consentId
      && Date.parse(input.authorization.expiresAt) > this.deps.clock.now().getTime();
  }
  private async valid(offer: StoredOffer, actor: OfferActor): Promise<boolean> {
    return offer.terms.clientId === actor.clientId && offer.terms.subjectToken === actor.subjectToken
      && offer.terms.status === 'definitive' && offer.terms.synthetic === true && await this.deps.integrity.verify(offer.terms, offer.seal, offer);
  }
  async create(input: Command & { quoteId: string }) {
    if (!this.deps.enabled) return { status: 'unavailable' as const };
    if (!this.authorized(input)) return { status: 'denied' as const };
    if (!validKey(input.idempotencyKey)) return { status: 'invalid' as const };
    const previous = await this.deps.store.byKey(input.actor, input.idempotencyKey);
    if (previous) return previous.terms.quoteId === input.quoteId && await this.valid(previous, input.actor)
      ? { status: 'replayed' as const, offer: previous.terms } : { status: 'conflict' as const };
    const quote = await this.deps.store.quote(input.actor, input.quoteId);
    if (!quote) return { status: 'not_found' as const };
    const now = this.deps.clock.now();
    if (Date.parse(quote.validUntil) <= now.getTime()) return { status: 'expired' as const };
    let signals;
    try { signals = await Promise.all(SIGNAL_SCOPES.map(scope => this.deps.provider.read(input.actor.subjectToken, scope, input.traceId))); }
    catch { return { status: 'unavailable' as const }; }
    if (!this.authorized(input)) return { status: 'denied' as const };
    const observedAt = this.deps.clock.now().getTime();
    if (Date.parse(quote.validUntil) <= observedAt) return { status: 'expired' as const };
    if (signals.some((s, i) => s.scope !== SIGNAL_SCOPES[i] || Date.parse(s.capturedAt) > observedAt || observedAt - Date.parse(s.capturedAt) > 120000 || !Number.isFinite(Date.parse(s.capturedAt)))) return { status: 'unavailable' as const };
    const decision = underwrite(quote, signals, input.authorization, input.traceId);
    if (!decision) return { status: 'unavailable' as const };
    if (!decision.accepted) { await this.deps.store.decline({ actor: input.actor, quote, capture: decision.capture, traceId: input.traceId }); return { status: 'declined' as const }; }
    // A slow or unavailable provider cannot stretch a previously verified authorization window.
    if (!this.authorized(input)) return { status: 'denied' as const };
    const terms = offerTerms(quote, input.actor, this.deps.integrity.id(), decision.premium, this.deps.clock.now(), input.authorization.expiresAt);
    const consent = { consentId: input.authorization.consentId, consentVersion: input.authorization.textVersion };
    const offer: StoredOffer = { terms, seal: await this.deps.integrity.seal(terms, consent), ...consent };
    const result = await this.deps.store.create({ actor: input.actor, quote, sourceReference: quote.quoteId, key: input.idempotencyKey, offer, capture: decision.capture, traceId: input.traceId });
    if (result.offer.terms.quoteId !== input.quoteId || !await this.valid(result.offer, input.actor)) return { status: 'conflict' as const };
    return { status: result.created ? 'created' as const : 'replayed' as const, offer: result.offer.terms };
  }
  async createFlight(input: { actor: OfferActor; flightReference: string; idempotencyKey: string; traceId: string }) {
    if (!this.deps.enabled) return { status: 'unavailable' as const };
    if (!validKey(input.idempotencyKey) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.flightReference)) return { status: 'invalid' as const };
    const previous = await this.deps.store.byKey(input.actor, input.idempotencyKey);
    if (previous) return previous.terms.coverage.kind === 'flight_delay' && previous.terms.coverage.flightReference === input.flightReference && await this.valid(previous, input.actor)
      ? { status: 'replayed' as const, offer: previous.terms } : { status: 'conflict' as const };
    let schedule;
    try { schedule = await this.deps.flights.read(input.flightReference); } catch { return { status: 'unavailable' as const }; }
    const now = this.deps.clock.now();
    if (!schedule.available || schedule.providerMode !== 'mock' || !Number.isFinite(Date.parse(schedule.capturedAt)) || Date.parse(schedule.capturedAt) > now.getTime() || now.getTime() - Date.parse(schedule.capturedAt) > 120000) return { status: 'unavailable' as const };
    const terms = { offerId: this.deps.integrity.id(), offerVersion: 1 as const, quoteId: null, ...input.actor,
      product: 'flight_delay' as const, premium: '10000.0000', currency: 'COP' as const,
      coverage: { kind: 'flight_delay' as const, flightReference: input.flightReference, thresholdMinutes: 180 as const, payoutAmount: '100000.0000' as const },
      effectiveFrom: now.toISOString(), effectiveUntil: new Date(now.getTime() + 86400000).toISOString(), expiresAt: new Date(now.getTime() + 15 * 60000).toISOString(),
      ruleVersion: 'academic-flight-1', synthetic: true as const, status: 'definitive' as const };
    const capture = { schemaVersion: 1, contractVersion: 'v1', correlationId: input.traceId, inputs: { premium: terms.premium, payoutAmount: terms.coverage.payoutAmount, thresholdMinutes: 180 },
      sources: [{ source: 'mock:flight-schedule', capturedAt: schedule.capturedAt, quality: 'mock', degraded: false }], consent: { status: 'not_required' }, rule: { id: 'flight-underwriting', version: terms.ruleVersion }, outcome: 'accepted' };
    const stored = { terms, seal: await this.deps.integrity.seal(terms, { consentId: '', consentVersion: 0 }), consentId: '', consentVersion: 0 };
    const result = await this.deps.store.create({ actor: input.actor, quote: null, sourceReference: input.flightReference, key: input.idempotencyKey, offer: stored, capture, traceId: input.traceId });
    if (result.offer.terms.coverage.kind !== 'flight_delay' || result.offer.terms.coverage.flightReference !== input.flightReference || !await this.valid(result.offer, input.actor)) return { status: 'conflict' as const };
    return { status: result.created ? 'created' as const : 'replayed' as const, offer: result.offer.terms };
  }
  async get(input: { actor: OfferActor; offerId: string }) {
    if (!this.deps.enabled) return { status: 'unavailable' as const };
    const offer = await this.deps.store.get(input.actor, input.offerId);
    if (!offer) return { status: 'not_found' as const };
    if (!await this.valid(offer, input.actor)) return { status: 'integrity_invalid' as const };
    return { status: 'found' as const, offer: offer.terms };
  }
  async accept(input: Omit<Command, 'authorization'> & { authorization?: OfferAuthorization; offerId: string }) {
    if (!this.deps.enabled) return { status: 'unavailable' as const };
    if (!validKey(input.idempotencyKey)) return { status: 'invalid' as const };
    const offer = await this.deps.store.get(input.actor, input.offerId);
    if (!offer) return { status: 'not_found' as const };
    if (offer.terms.product === 'vida_hipotecario' && (!input.authorization || !this.authorized({ ...input, authorization: input.authorization })
      || input.authorization.consentId !== offer.consentId || input.authorization.textVersion !== offer.consentVersion)) return { status: 'denied' as const };
    if (!await this.valid(offer, input.actor)) { await this.deps.store.reject(input.actor, input.offerId, input.traceId, 'integrity_invalid'); return { status: 'integrity_invalid' as const }; }
    const previous = await this.deps.store.acceptance(input.actor, input.idempotencyKey);
    if (previous) return previous.offerId === input.offerId ? { status: 'replayed' as const, acceptance: previous } : { status: 'conflict' as const };
    const now = this.deps.clock.now().toISOString();
    if (Date.parse(offer.terms.expiresAt) <= Date.parse(now)) { await this.deps.store.reject(input.actor, input.offerId, input.traceId, 'expired'); return { status: 'expired' as const }; }
    const acceptance = { acceptanceId: this.deps.integrity.id(), offerId: input.offerId, eventId: this.deps.integrity.id(), acceptedAt: now, status: 'pending_issuance' as const, synthetic: true as const };
    const t = offer.terms;
    const event = await this.deps.integrity.sign({ version: 1, eventType: 'offer.accepted', eventId: acceptance.eventId, environment: this.deps.environment, synthetic: true, occurredAt: now, correlationId: input.traceId,
      payload: { acceptanceId: acceptance.acceptanceId, offerId: t.offerId, offerVersion: t.offerVersion, clientId: t.clientId, subjectToken: t.subjectToken, product: t.product, premium: t.premium, currency: t.currency, coverage: t.coverage, effectiveFrom: t.effectiveFrom, effectiveUntil: t.effectiveUntil, expiresAt: t.expiresAt, ruleVersion: t.ruleVersion, acceptedAt: now } });
    return this.deps.store.accept({ actor: input.actor, key: input.idempotencyKey, offer, event, acceptance, traceId: input.traceId, now,
      authorizedUntil: input.authorization?.expiresAt ?? offer.terms.expiresAt });
  }
}
