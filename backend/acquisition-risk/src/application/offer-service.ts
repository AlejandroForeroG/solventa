import { offerRequestIdentity, offerTerms, underwrite, type OfferActor, type OfferAuthorization, type OfferSignalSource } from '../domain/offer';
import { CONFIDENCE, SIGNAL_FRESHNESS_MS, SIGNAL_SCOPES } from '../domain/signal';
import type { Clock } from './ports/platform';
import type { FlightSchedule, OfferCreationSnapshot, OfferIntegrity, OfferStore, StoredOffer, OfferRequestResult } from './ports/offer-store';
import type { SignalResult } from './read-signal';
import type { DependencyTimings } from './dependency-timings';

type Command = { actor: OfferActor; idempotencyKey: string; traceId: string; authorization: OfferAuthorization; timings?: DependencyTimings };
type OfferSignalReader = { executeAllAuthorized(input: { subjectToken: string; traceId: string; consent: { allowed: true } & OfferAuthorization; timings?: DependencyTimings }): Promise<{ results: SignalResult[]; confidence: number }> };
const validKey = (key: string) => typeof key === 'string' && key.length > 0 && key.length <= 128;

export class OfferService {
  constructor(private readonly deps: { store: OfferStore; signals: OfferSignalReader; flights: FlightSchedule; integrity: OfferIntegrity; clock: Clock; environment: string; enabled: boolean }) {}
  private authorized(input: Command): boolean {
    return this.deps.enabled && input.authorization.textVersion > 0 && !!input.authorization.consentId
      && Date.parse(input.authorization.expiresAt) > this.deps.clock.now().getTime();
  }
  private timed<T>(input: Pick<Command, 'timings'>, name: string, call: () => Promise<T>): Promise<T> {
    return input.timings ? input.timings.measure(name, call) : call();
  }
  private async valid(offer: StoredOffer, actor: OfferActor): Promise<boolean> {
    try {
      return offer.terms.clientId === actor.clientId && offer.terms.subjectToken === actor.subjectToken
        && offer.terms.synthetic === true && await this.deps.integrity.verify(offer.terms, offer.seal, offer);
    } catch { return false; }
  }
  private async outcome(result: OfferRequestResult, actor: OfferActor, identity: string) {
    const request = result.request;
    if (request.actor.clientId !== actor.clientId || request.actor.subjectToken !== actor.subjectToken || request.requestIdentity !== identity) return { status: 'conflict' as const };
    if (request.outcome === 'declined') return { status: 'declined' as const };
    if (!await this.valid(request.offer, actor)) return { status: 'conflict' as const };
    const source = request.offer.terms.coverage.kind === 'flight_delay' ? request.offer.terms.coverage.flightReference : request.offer.terms.quoteId;
    if (!source || offerRequestIdentity(request.offer.terms.product, source) !== identity) return { status: 'conflict' as const };
    return { status: result.created ? 'created' as const : 'replayed' as const, offer: request.offer.terms };
  }
  private async previous(snapshot: OfferCreationSnapshot, actor: OfferActor, identity: string) {
    if (snapshot.request) return this.outcome({ created: false, request: snapshot.request }, actor, identity);
    // Compatibility: offers created before the outcome ledger keep their original idempotency key.
    const old = snapshot.legacy;
    if (!old) return null;
    if (!await this.valid(old, actor)) return { status: 'conflict' as const };
    const reference = old.terms.coverage.kind === 'flight_delay' ? old.terms.coverage.flightReference : old.terms.quoteId;
    if (!reference || offerRequestIdentity(old.terms.product, reference) !== identity) return { status: 'conflict' as const };
    return { status: 'replayed' as const, offer: old.terms };
  }
  async create(input: Command & { quoteId: string }) {
    if (!this.deps.enabled) return { status: 'unavailable' as const };
    if (!this.authorized(input)) return { status: 'denied' as const };
    if (!validKey(input.idempotencyKey)) return { status: 'invalid' as const };
    const requestIdentity = offerRequestIdentity('vida_hipotecario', input.quoteId);
    const snapshot = await this.timed(input, 'offer_read', () => this.deps.store.creationSnapshot(input.actor, input.idempotencyKey, input.quoteId));
    const previous = await this.previous(snapshot, input.actor, requestIdentity);
    if (previous) return previous;
    const quote = snapshot.quote;
    if (!quote) return { status: 'not_found' as const };
    const now = this.deps.clock.now();
    if (Date.parse(quote.validUntil) <= now.getTime()) return { status: 'expired' as const };
    let observed;
    try { observed = await this.deps.signals.executeAllAuthorized({ subjectToken: input.actor.subjectToken, traceId: input.traceId, consent: { allowed: true, ...input.authorization }, timings: input.timings }); }
    catch { return { status: 'unavailable' as const }; }
    if (observed.results.some(result => result.status === 'denied')) return { status: 'denied' as const };
    const readable = observed.results.filter((result): result is Exclude<SignalResult, { status: 'denied' }> => result.status !== 'denied');
    const signals = readable.map(result => result.signal);
    if (!this.authorized(input)) return { status: 'denied' as const };
    const observedAt = this.deps.clock.now().getTime();
    if (Date.parse(quote.validUntil) <= observedAt) return { status: 'expired' as const };
    if (signals.length !== SIGNAL_SCOPES.length || signals.some((s, index) => s.scope !== SIGNAL_SCOPES[index]
      || Date.parse(s.capturedAt) > observedAt || observedAt - Date.parse(s.capturedAt) > SIGNAL_FRESHNESS_MS || !Number.isFinite(Date.parse(s.capturedAt)))) return { status: 'unavailable' as const };
    const provenance: OfferSignalSource[] = readable.map(result => result.status === 'available'
      ? { scope: result.signal.scope, quality: 'live', degraded: false, confidence: CONFIDENCE.live }
      : { scope: result.signal.scope, quality: result.degradation.substitute, degraded: true, confidence: result.degradation.confidence,
        failure: result.degradation.failure, substitute: result.degradation.substitute });
    const decision = underwrite(quote, signals, input.authorization, input.traceId, provenance);
    if (!decision) return { status: 'unavailable' as const };
    if (!decision.accepted && !decision.preliminary) {
      const result = await this.timed(input, 'offer_write', () => this.deps.store.decline({ actor: input.actor, quote, key: input.idempotencyKey, requestIdentity, capture: decision.capture, traceId: input.traceId }));
      return this.outcome(result, input.actor, requestIdentity);
    }
    // A slow or unavailable provider cannot stretch a previously verified authorization window.
    if (!this.authorized(input)) return { status: 'denied' as const };
    const terms = offerTerms(quote, input.actor, this.deps.integrity.id(), decision.premium, this.deps.clock.now(), input.authorization.expiresAt,
      decision.preliminary ? 'preliminary' : 'definitive');
    const consent = { consentId: input.authorization.consentId, consentVersion: input.authorization.textVersion };
    const offer: StoredOffer = { terms, seal: await this.deps.integrity.seal(terms, consent), ...consent };
    const result = await this.timed(input, 'offer_write', () => this.deps.store.create({ actor: input.actor, quote, sourceReference: quote.quoteId, requestIdentity, key: input.idempotencyKey, offer, capture: decision.capture, traceId: input.traceId }));
    return this.outcome(result, input.actor, requestIdentity);
  }
  async createFlight(input: { actor: OfferActor; flightReference: string; idempotencyKey: string; traceId: string }) {
    if (!this.deps.enabled) return { status: 'unavailable' as const };
    if (!validKey(input.idempotencyKey) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.flightReference)) return { status: 'invalid' as const };
    const requestIdentity = offerRequestIdentity('flight_delay', input.flightReference);
    const previous = await this.previous(await this.deps.store.creationSnapshot(input.actor, input.idempotencyKey, null), input.actor, requestIdentity);
    if (previous) return previous;
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
    const result = await this.deps.store.create({ actor: input.actor, quote: null, sourceReference: input.flightReference, requestIdentity, key: input.idempotencyKey, offer: stored, capture, traceId: input.traceId });
    return this.outcome(result, input.actor, requestIdentity);
  }
  async get(input: { actor: OfferActor; offerId: string; traceId: string }) {
    if (!this.deps.enabled) return { status: 'unavailable' as const };
    const offer = await this.deps.store.get(input.actor, input.offerId);
    if (!offer) return { status: 'not_found' as const };
    if (!await this.valid(offer, input.actor)) {
      try { await this.deps.store.reject(input.actor, input.offerId, input.traceId, 'integrity_invalid', 'offer.read'); }
      catch { return { status: 'unavailable' as const }; }
      return { status: 'integrity_invalid' as const };
    }
    return { status: 'found' as const, offer: offer.terms };
  }
  async accept(input: Omit<Command, 'authorization'> & { authorization?: OfferAuthorization; offerId: string }) {
    if (!this.deps.enabled) return { status: 'unavailable' as const };
    if (!validKey(input.idempotencyKey)) return { status: 'invalid' as const };
    const { offer, acceptance: previous } = await this.deps.store.acceptanceSnapshot(input.actor, input.offerId, input.idempotencyKey);
    if (!offer) return { status: 'not_found' as const };
    if (offer.terms.product === 'vida_hipotecario' && (!input.authorization || !this.authorized({ ...input, authorization: input.authorization })
      || input.authorization.consentId !== offer.consentId || input.authorization.textVersion !== offer.consentVersion)) return { status: 'denied' as const };
    if (!await this.valid(offer, input.actor)) { await this.deps.store.reject(input.actor, input.offerId, input.traceId, 'integrity_invalid'); return { status: 'integrity_invalid' as const }; }
    if (offer.terms.status !== 'definitive') return { status: 'conflict' as const };
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
