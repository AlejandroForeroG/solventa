export const ADVISOR_SALE_OPERATION = 'advisor-sale:prepare';
export const DEFAULT_VALIDITY_DAYS = 1;
export const MAX_VALIDITY_DAYS = 7;
// Fewer than the list page, so every authorization that still works is always listed and can be revoked.
export const MAX_ACTIVE_AUTHORIZATIONS = 20;
const DAY_MS = 24 * 3600 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AdvisorSaleAuthorization = {
  id: string;
  advisorReference: string;
  operation: typeof ADVISOR_SALE_OPERATION;
  grantedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};
export type AdvisorSaleAuthorizationStatus = 'active' | 'revoked' | 'expired';

// Computed on every read, never stored, so it cannot go stale.
export function authorizationStatus(authorization: Pick<AdvisorSaleAuthorization, 'expiresAt' | 'revokedAt'>, now: Date): AdvisorSaleAuthorizationStatus {
  if (authorization.revokedAt) return 'revoked';
  return authorization.expiresAt.getTime() <= now.getTime() ? 'expired' : 'active';
}

export type GrantRequest = { advisorReference: string; validityDays: number };

// The customer names the advisor and the duration; nothing else is accepted from the body.
export function validateGrantRequest(body: unknown): GrantRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== 'advisorReference' && key !== 'validityDays')) return null;
  if (typeof input.advisorReference !== 'string' || !UUID.test(input.advisorReference)) return null;
  const days = input.validityDays ?? DEFAULT_VALIDITY_DAYS;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_VALIDITY_DAYS) return null;
  return { advisorReference: input.advisorReference.toLowerCase(), validityDays: days };
}

export function expiryFor(grantedAt: Date, validityDays: number): Date {
  return new Date(grantedAt.getTime() + validityDays * DAY_MS);
}
