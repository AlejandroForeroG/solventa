import type { AccessDecision } from './api-access';
import type { ConsentDecision, ConsentScopesCheck } from './consents';
import type { PartnerAuthorizationStore } from './ports/partner-authorizations';
import type { SecurityDecisions } from './security-decisions';

export type RiskConsent = { consentId: string; textVersion: number; expiresAt: string };
export type PartnerOfferAccessDecision =
  | { allowed: true; partnerId: string; customer: { clientId: string; subjectToken: string }; authorizationExpiresAt: string; consent: RiskConsent }
  | { allowed: false; error: 'invalid_request' | 'unauthorized' | 'forbidden' | 'access_unavailable' | 'consent_required'; status: 400 | 401 | 403 | 503 };

const OPERATION = 'partner-offers:create';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const RISK_SCOPES = ['income_obligations_12m', 'payment_history_score', 'affiliation_regime', 'identity_validation'] as const;
const failure = (error: 'invalid_request' | 'forbidden' | 'access_unavailable' | 'consent_required', status: 400 | 403 | 503) => ({ allowed: false, error, status }) as const;

// The one consent that covers every scope, or null when any scope lacks the same current grant.
function singleConsent(decisions: ConsentDecision[]): RiskConsent | null {
  let found: RiskConsent | null = null;
  for (const decision of decisions) {
    if (!decision.allowed) return null;
    const { consentId, textVersion, expiresAt } = decision.consent;
    if (found && (found.consentId !== consentId || found.textVersion !== textVersion || found.expiresAt !== expiresAt)) return null;
    found = { consentId, textVersion, expiresAt };
  }
  return found;
}

// One RPC answers who the partner is, which customer authorized it and whether that customer's consent is fresh.
// The partner never names the customer: only the authorization it holds leads to one.
export async function authorizePartnerOfferAccess(deps: {
  authorize(input: unknown): Promise<AccessDecision>;
  authorizations: Pick<PartnerAuthorizationStore, 'find'>;
  verifyConsents(input: ConsentScopesCheck): Promise<ConsentDecision[]>;
  security?: Pick<SecurityDecisions, 'deny'>;
}, input: unknown): Promise<PartnerOfferAccessDecision> {
  if (!input || typeof input !== 'object' || !('token' in input) || typeof input.token !== 'string'
    || !('authorizationId' in input) || typeof input.authorizationId !== 'string' || !UUID.test(input.authorizationId)) return failure('invalid_request', 400);
  const traceId = 'traceId' in input && typeof input.traceId === 'string' ? input.traceId : undefined;
  try {
    const access = await deps.authorize({ kind: 'partner', token: input.token, operation: OPERATION, traceId });
    if (!access.allowed) return access;
    if (access.actor.kind !== 'partner') return failure('access_unavailable', 503);
    const partnerId = access.actor.partnerId;
    const denied = async (error: 'forbidden' | 'consent_required') => {
      await deps.security?.deny({ category: 'api_access', channel: 'partner', operation: OPERATION, cause: 'forbidden' }, traceId);
      return failure(error, 403);
    };
    // Unknown, foreign, revoked and expired authorizations are indistinguishable to the partner.
    const customer = await deps.authorizations.find(partnerId, input.authorizationId.toLowerCase());
    if (!customer) return await denied('forbidden');
    const decisions = await deps.verifyConsents({ subjectToken: customer.subjectToken, purposeCode: 'risk_profiling', scopes: RISK_SCOPES });
    if (decisions.length !== RISK_SCOPES.length || decisions.some(decision => !decision.allowed && decision.reason === 'unavailable')) return failure('access_unavailable', 503);
    const consent = singleConsent(decisions);
    if (!consent) return await denied('consent_required');
    return { allowed: true, partnerId, customer: { clientId: customer.clientId, subjectToken: customer.subjectToken }, authorizationExpiresAt: customer.expiresAt, consent };
  } catch { return failure('access_unavailable', 503); }
}
