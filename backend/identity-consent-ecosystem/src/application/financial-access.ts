import type { AccessDecision, UserActor } from './api-access';
import type { ConsentCheck, ConsentDecision } from './consents';
import type { SecurityDecisions } from './security-decisions';

export type FinancialAccessDecision =
  | { allowed: true; actor: UserActor; consent?: { consentId: string; textVersion: number; expiresAt: string } }
  | { allowed: false; error: 'invalid_request' | 'unauthorized' | 'forbidden' | 'access_unavailable' | 'consent_required'; status: 400 | 401 | 403 | 503 };

const operations = ['offers:create', 'offers:create-flight', 'offers:read', 'offers:accept', 'policies:read', 'policies:issue'];
const scopes = ['income_obligations_12m', 'payment_history_score', 'affiliation_regime', 'identity_validation'];

// One RPC encloses Identity's own authentication and fresh consent checks; no remote fan-out is needed.
export async function authorizeFinancialAccess(deps: {
  authorize(input: unknown): Promise<AccessDecision>;
  verifyConsent(input: ConsentCheck): Promise<ConsentDecision>;
  security?: Pick<SecurityDecisions, 'deny'>;
}, input: unknown): Promise<FinancialAccessDecision> {
  if (!input || typeof input !== 'object' || !('operation' in input) || typeof input.operation !== 'string' || !operations.includes(input.operation)) {
    return { allowed: false, error: 'invalid_request', status: 400 };
  }
  if (!('kind' in input) || input.kind !== 'web') return { allowed: false, error: 'forbidden', status: 403 };
  try {
    const access = await deps.authorize(input);
    if (!access.allowed) return access;
    if (access.actor.kind !== 'user' || access.actor.channel !== 'web') return { allowed: false, error: 'forbidden', status: 403 };
    if (input.operation !== 'offers:create' && input.operation !== 'offers:accept') return { allowed: true, actor: access.actor };
    let authorized: { consentId: string; textVersion: number; expiresAt: string } | undefined;
    for (const scope of scopes) {
      const decision = await deps.verifyConsent({ subjectToken: access.actor.principal.subjectToken, purposeCode: 'risk_profiling', scope });
      if (!decision.allowed) {
        if (decision.reason === 'unavailable') return { allowed: false, error: 'access_unavailable', status: 503 };
        // Acceptance of a no-signals product needs no risk-data consent. The owner still requires
        // a current authorization for mortgage acceptance, and receives none on this branch.
        if (input.operation === 'offers:accept') return { allowed: true, actor: access.actor };
        await deps.security?.deny({ category: 'api_access', channel: 'web', operation: 'offers:create', cause: 'forbidden' }, 'traceId' in input ? input.traceId : undefined);
        return { allowed: false, error: 'consent_required', status: 403 };
      }
      if (authorized && (authorized.consentId !== decision.consent.consentId || authorized.textVersion !== decision.consent.textVersion || authorized.expiresAt !== decision.consent.expiresAt)) {
        await deps.security?.deny({ category: 'api_access', channel: 'web', operation: input.operation, cause: 'forbidden' }, 'traceId' in input ? input.traceId : undefined);
        return { allowed: false, error: 'consent_required', status: 403 };
      }
      authorized = decision.consent;
    }
    return { allowed: true, actor: access.actor, consent: authorized };
  } catch { return { allowed: false, error: 'access_unavailable', status: 503 }; }
}
