import type { PartnerOfferAccess, PartnerOfferDecision } from '../../application/ports/partner-offer-access';

// The Service Binding to Identity (`authorizePartnerOfferAccessV1`). Its reply is untrusted until validated here.
export interface IdentityPartnerOfferRpc {
  authorizePartnerOfferAccessV1(request: unknown): Promise<unknown>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const consentCode = /^CNS-\d{4}-\d{5,19}$/;
const unavailable: PartnerOfferDecision = { allowed: false, error: 'access_unavailable', status: 503 };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

function decisionFrom(reply: unknown): PartnerOfferDecision {
  if (!isRecord(reply)) return unavailable;
  if (reply.allowed === true) {
    const { customer, consent } = reply;
    if (!isUuid(reply.partnerId) || !isTime(reply.authorizationExpiresAt) || !isRecord(customer) || !isUuid(customer.clientId) || !isUuid(customer.subjectToken)
      || !isRecord(consent) || typeof consent.consentId !== 'string' || !consentCode.test(consent.consentId)
      || typeof consent.textVersion !== 'number' || !Number.isSafeInteger(consent.textVersion) || consent.textVersion < 1 || !isTime(consent.expiresAt)) return unavailable;
    return { allowed: true, partnerId: reply.partnerId.toLowerCase(), authorizationExpiresAt: reply.authorizationExpiresAt,
      customer: { clientId: customer.clientId.toLowerCase(), subjectToken: customer.subjectToken.toLowerCase() },
      consent: { consentId: consent.consentId, textVersion: consent.textVersion, expiresAt: consent.expiresAt } };
  }
  if (reply.allowed === false && reply.status === 429 && reply.error === 'quota_exceeded' && typeof reply.retryAfter === 'number'
    && Number.isSafeInteger(reply.retryAfter) && reply.retryAfter >= 1 && reply.retryAfter <= 86400)
    return { allowed: false, error: 'quota_exceeded', status: 429, retryAfter: reply.retryAfter };
  // A 400 from Identity means this adapter sent an invalid request: an integration failure, never a caller error.
  if (reply.status === 401 && reply.error === 'unauthorized') return { allowed: false, error: 'unauthorized', status: 401 };
  if (reply.status === 403 && reply.error === 'forbidden') return { allowed: false, error: 'forbidden', status: 403 };
  if (reply.status === 403 && reply.error === 'consent_required') return { allowed: false, error: 'consent_required', status: 403 };
  return unavailable;
}

export class IdentityPartnerOfferAccess implements PartnerOfferAccess {
  constructor(private readonly identity: IdentityPartnerOfferRpc, private readonly deadlineMs = 2000) {}

  async authorize(input: { token: string; authorizationId: string; traceId: string }): Promise<PartnerOfferDecision> {
    // An oversized token keeps its kind but is dropped, so Identity records a canonical denial without receiving it.
    const request = { ...input, token: input.token.length <= 8192 ? input.token : '' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([
        this.identity.authorizePartnerOfferAccessV1(request),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('access_deadline')), this.deadlineMs); })
      ]);
      return decisionFrom(reply);
    } catch {
      return unavailable;
    } finally {
      clearTimeout(timer);
    }
  }
}
