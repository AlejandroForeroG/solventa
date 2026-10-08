import { ageOn, decisionCapture, monthlyPremium, RULE_VERSION, validateQuoteRequest, VALIDITY_DAYS, type FieldError } from '../domain/quote';
import type { AccessCredential, AccessDenial, ApiAccess } from './ports/api-access';
import type { QuoteStore, StoredQuote } from './ports/quote-store';
import type { Clock, Protector } from './ports/platform';

export type CreateQuoteInput = { credential: AccessCredential | null; idempotencyKey: string | null; body: unknown; traceId: string };

export type CreateQuoteResult =
  | { status: 'created' | 'replayed'; quote: StoredQuote & { currency: 'COP'; basis: 'minimum_data'; traceId: string } }
  | { status: 'denied'; error: AccessDenial; httpStatus: 401 | 403 | 503 }
  | { status: 'invalid'; errors: FieldError[] }
  | { status: 'idempotency_conflict' };

const BOGOTA_OFFSET_MS = 5 * 3600 * 1000; // Colombia has no daylight saving time.
const DAY_MS = 24 * 3600 * 1000;

export class CreateQuote {
  constructor(private readonly deps: { access: ApiAccess; store: QuoteStore; clock: Clock; protector: Protector }) {}

  async execute(input: CreateQuoteInput): Promise<CreateQuoteResult> {
    // Before validation, so a caller without access learns nothing about the rules.
    if (!input.credential) return { status: 'denied', error: 'unauthorized', httpStatus: 401 };
    const decision = await this.deps.access.authorize(input.credential);
    if (!decision.allowed) return { status: 'denied', error: decision.error, httpStatus: decision.status };
    const { actor } = decision;

    const key = input.idempotencyKey;
    if (key === null || key.length < 1) return { status: 'invalid', errors: [{ field: 'Idempotency-Key', code: 'required' }] };
    if (key.length > 128) return { status: 'invalid', errors: [{ field: 'Idempotency-Key', code: 'invalid_format' }] };

    const now = this.deps.clock.now();
    const today = new Date(now.getTime() - BOGOTA_OFFSET_MS).toISOString().slice(0, 10);
    const checked = validateQuoteRequest(input.body, today);
    if (!checked.ok) return { status: 'invalid', errors: checked.errors };

    const { request } = checked;
    const age = ageOn(request.customer.birthDate, today);
    const actorId = actor.kind === 'partner' ? actor.partnerId : actor.clientId;
    // A web user is identified by the session, never by the body.
    const subjectToken = actor.kind === 'partner' ? await this.deps.protector.documentToken(request.customer.documentNumber) : actor.subjectToken;
    const saved = await this.deps.store.save({
      actor,
      subjectToken,
      idempotencyKey: key,
      requestFingerprint: await this.deps.protector.fingerprint(actorId, request),
      capture: decisionCapture(request, age, input.traceId),
      amount: request.credit.amount,
      termMonths: request.credit.termMonths,
      premiumMonthly: monthlyPremium(request.credit.amount, age),
      ruleVersion: RULE_VERSION,
      validUntil: new Date(now.getTime() + VALIDITY_DAYS * DAY_MS).toISOString(),
      year: Number(today.slice(0, 4)),
      traceId: input.traceId
    });
    if (saved.kind === 'conflict') return { status: 'idempotency_conflict' };
    return { status: saved.kind, quote: { ...saved.quote, currency: 'COP', basis: 'minimum_data', traceId: input.traceId } };
  }
}
