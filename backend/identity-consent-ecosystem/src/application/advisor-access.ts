import type { AccessDecision } from './api-access';
import type { Principal, VerifiedIdentity } from './authentication';
import type { SecurityDecisions } from './security-decisions';

export type AdvisorPermission = { reference: string; expiresAt: string };
export type EligibleAdvisor = AdvisorPermission & { principal: Principal };
export interface AdvisorPermissions {
  find(principal: Principal, identity: VerifiedIdentity): Promise<AdvisorPermission | null>;
  eligible(reference: string): Promise<EligibleAdvisor | null>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unavailable = { allowed: false, error: 'access_unavailable', status: 503 } as const;

// The policy owner approves the concrete action in Policy; this lookup only verifies professional eligibility.
export async function authorizeAdvisorApproval(deps: {
  authorize(input: unknown): Promise<AccessDecision>; advisors: Pick<AdvisorPermissions, 'eligible'>; security?: Pick<SecurityDecisions, 'deny'>;
}, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !('advisorReference' in input)
    || typeof input.advisorReference !== 'string' || !uuid.test(input.advisorReference)
    || !('kind' in input) || input.kind !== 'web') return { allowed: false, error: 'invalid_request', status: 400 } as const;
  const { advisorReference, ...request } = input;
  try {
    const access = await deps.authorize({ ...request, operation: 'policies:manage' });
    if (!access.allowed) return access;
    if (access.actor.kind !== 'user' || access.actor.channel !== 'web' || !access.actor.operations.includes('policies:manage')) return unavailable;
    const advisor = await deps.advisors.eligible(advisorReference.toLowerCase());
    if (!advisor || advisor.principal.clientId === access.actor.principal.clientId) {
      await deps.security?.deny({ category: 'api_access', channel: 'web', operation: 'policies:manage', cause: 'forbidden' }, 'traceId' in input ? input.traceId : undefined);
      return { allowed: false, error: 'forbidden', status: 403 } as const;
    }
    const lease = Date.parse(advisor.expiresAt);
    if (!(lease > Date.now()) || lease > Date.now() + 5500) return unavailable;
    return { allowed: true, actor: access.actor, advisor } as const;
  } catch { return unavailable; }
}
