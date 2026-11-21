import type { AccessDecision } from './api-access';
import type { AdvisorPermissions } from './advisor-access';
import type { ConsentDecision, ConsentScopesCheck } from './consents';
import type { AdvisorSaleAuthorizationStore } from './ports/advisor-sale-authorizations';
import type { SecurityDecisions } from './security-decisions';
import { RISK_SCOPES, type RiskConsent } from './partner-offer-access';

export type AdvisorSaleAccessDecision =
  | { allowed: true; advisorReference: string; customer: { clientId: string; subjectToken: string }; authorizationExpiresAt: string; leaseExpiresAt: string; consent: RiskConsent }
  | { allowed: false; error: 'invalid_request' | 'unauthorized' | 'forbidden' | 'access_unavailable' | 'consent_required'; status: 400 | 401 | 403 | 503 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LEASE_MS = 5500;
const failure = (error: 'invalid_request' | 'forbidden' | 'access_unavailable' | 'consent_required', status: 400 | 403 | 503) => ({ allowed: false, error, status }) as const;

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

// One RPC answers who the advisor is, which customer authorized that advisor and whether the customer's consent is fresh.
// The advisor never names the customer: only the authorization it holds leads to one.
export async function authorizeAdvisorSaleAccess(deps: {
  authorize(input: unknown): Promise<AccessDecision>;
  advisors: Pick<AdvisorPermissions, 'eligible'>;
  authorizations: Pick<AdvisorSaleAuthorizationStore, 'find'>;
  verifyConsents(input: ConsentScopesCheck): Promise<ConsentDecision[]>;
  security?: Pick<SecurityDecisions, 'deny'>;
}, input: unknown): Promise<AdvisorSaleAccessDecision> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !('kind' in input) || input.kind !== 'web'
    || !('authorizationId' in input) || typeof input.authorizationId !== 'string' || !UUID.test(input.authorizationId)) return failure('invalid_request', 400);
  const { authorizationId, ...request } = input;
  const traceId = 'traceId' in input && typeof input.traceId === 'string' ? input.traceId : undefined;
  try {
    const access = await deps.authorize({ ...request, operation: 'policies:manage-delegated' });
    if (!access.allowed) return access;
    if (access.actor.kind !== 'user' || access.actor.channel !== 'web' || !access.actor.advisorPermission) return failure('access_unavailable', 503);
    const advisorReference = access.actor.advisorPermission.reference;
    // The permission is a short lease: it is handed on so the sale respects it separately from the offer's own validity.
    const lease = Date.parse(access.actor.advisorPermission.expiresAt);
    if (!(lease > Date.now()) || lease > Date.now() + MAX_LEASE_MS) return failure('access_unavailable', 503);
    const denied = async (error: 'forbidden' | 'consent_required') => {
      await deps.security?.deny({ category: 'api_access', channel: 'web', operation: 'advisor-sale:prepare', cause: 'forbidden' }, traceId);
      return failure(error, 403);
    };
    // Unknown, foreign, revoked and expired authorizations are indistinguishable to the advisor, and so is acting on oneself.
    const customer = await deps.authorizations.find(advisorReference, authorizationId.toLowerCase());
    if (!customer || customer.clientId === access.actor.principal.clientId) return await denied('forbidden');
    const decisions = await deps.verifyConsents({ subjectToken: customer.subjectToken, purposeCode: 'risk_profiling', scopes: RISK_SCOPES });
    if (decisions.length !== RISK_SCOPES.length || decisions.some(decision => !decision.allowed && decision.reason === 'unavailable')) return failure('access_unavailable', 503);
    const consent = singleConsent(decisions);
    if (!consent) return await denied('consent_required');
    return { allowed: true, advisorReference, customer: { clientId: customer.clientId, subjectToken: customer.subjectToken }, authorizationExpiresAt: customer.expiresAt, leaseExpiresAt: access.actor.advisorPermission.expiresAt, consent };
  } catch { return failure('access_unavailable', 503); }
}
