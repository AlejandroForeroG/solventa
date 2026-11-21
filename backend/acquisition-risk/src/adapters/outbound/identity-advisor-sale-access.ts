import type { AdvisorSaleAccess, AdvisorSaleDecision, AdvisorSessionCredential } from '../../application/ports/advisor-sale-access';

// The Service Binding to Identity (`authorizeAdvisorSaleV1`). Its reply is untrusted until validated here.
export interface IdentityAdvisorSaleRpc {
  authorizeAdvisorSaleV1(request: unknown): Promise<unknown>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const consentCode = /^CNS-\d{4}-\d{5,19}$/;
const MAX_LEASE_MS = 5500;
const unavailable: AdvisorSaleDecision = { allowed: false, error: 'access_unavailable', status: 503 };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

function decisionFrom(reply: unknown): AdvisorSaleDecision {
  if (!isRecord(reply)) return unavailable;
  if (reply.allowed === true) {
    const { customer, consent } = reply;
    const lease = isTime(reply.leaseExpiresAt) ? Date.parse(reply.leaseExpiresAt) : NaN;
    // The lease is short by design: one that is over, or that Identity would never grant, is not a usable permission.
    if (!(lease > Date.now()) || lease > Date.now() + MAX_LEASE_MS) return unavailable;
    if (!isUuid(reply.advisorReference) || !isTime(reply.authorizationExpiresAt) || !isRecord(customer) || !isUuid(customer.clientId) || !isUuid(customer.subjectToken)
      || !isRecord(consent) || typeof consent.consentId !== 'string' || !consentCode.test(consent.consentId)
      || typeof consent.textVersion !== 'number' || !Number.isSafeInteger(consent.textVersion) || consent.textVersion < 1 || !isTime(consent.expiresAt)) return unavailable;
    return { allowed: true, advisorReference: reply.advisorReference.toLowerCase(), authorizationExpiresAt: reply.authorizationExpiresAt, leaseExpiresAt: reply.leaseExpiresAt as string,
      customer: { clientId: customer.clientId.toLowerCase(), subjectToken: customer.subjectToken.toLowerCase() },
      consent: { consentId: consent.consentId, textVersion: consent.textVersion, expiresAt: consent.expiresAt } };
  }
  // A 400 from Identity means this adapter sent an invalid request: an integration failure, never a caller error.
  if (reply.status === 401 && reply.error === 'unauthorized') return { allowed: false, error: 'unauthorized', status: 401 };
  if (reply.status === 403 && reply.error === 'forbidden') return { allowed: false, error: 'forbidden', status: 403 };
  if (reply.status === 403 && reply.error === 'consent_required') return { allowed: false, error: 'consent_required', status: 403 };
  return unavailable;
}

export class IdentityAdvisorSaleAccess implements AdvisorSaleAccess {
  constructor(private readonly identity: IdentityAdvisorSaleRpc, private readonly deadlineMs = 2000) {}

  async authorize(input: { session: AdvisorSessionCredential; authorizationId: string; traceId: string }): Promise<AdvisorSaleDecision> {
    // Oversized untrusted values are dropped, so Identity records a canonical denial without receiving them.
    const { session } = input;
    const request = { kind: 'web', cookie: session.cookie.length <= 16384 ? session.cookie : '', origin: session.origin.length <= 256 ? session.origin : '',
      requestOrigin: session.requestOrigin.length <= 256 ? session.requestOrigin : '', method: session.method,
      authorizationId: input.authorizationId, traceId: input.traceId };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([
        this.identity.authorizeAdvisorSaleV1(request),
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
