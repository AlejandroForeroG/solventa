export const PARTNER_OFFER_OPERATION = 'partner-offers:create';
export const DEFAULT_VALIDITY_DAYS = 30;
export const MAX_VALIDITY_DAYS = 90;
const DAY_MS = 24 * 3600 * 1000;

export type PartnerAuthorization = {
  id: string;
  partnerCode: string;
  operation: typeof PARTNER_OFFER_OPERATION;
  grantedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};
export type PartnerAuthorizationStatus = 'active' | 'revoked' | 'expired';

// Computed on every read, never stored, so it cannot go stale.
export function authorizationStatus(authorization: Pick<PartnerAuthorization, 'expiresAt' | 'revokedAt'>, now: Date): PartnerAuthorizationStatus {
  if (authorization.revokedAt) return 'revoked';
  return authorization.expiresAt.getTime() <= now.getTime() ? 'expired' : 'active';
}

export type GrantRequest = { partnerCode: string; validityDays: number };

// The customer names the partner and the duration; nothing else is accepted from the body.
export function validateGrantRequest(body: unknown): GrantRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== 'partnerCode' && key !== 'validityDays')) return null;
  if (typeof input.partnerCode !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.partnerCode)) return null;
  const days = input.validityDays ?? DEFAULT_VALIDITY_DAYS;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_VALIDITY_DAYS) return null;
  return { partnerCode: input.partnerCode, validityDays: days };
}

export function expiryFor(grantedAt: Date, validityDays: number): Date {
  return new Date(grantedAt.getTime() + validityDays * DAY_MS);
}
