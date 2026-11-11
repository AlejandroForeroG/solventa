export type PartnerQuota = { configured: true; limit: number; used: number; remaining: number;
  windowStart: string; resetsAt: string; trackingSince: string; updatedAt: string; timeZone: 'UTC' };
export type QuotaDenial = { allowed: false; error: 'quota_exceeded'; status: 429; retryAfter: number }
  | { allowed: false; error: 'access_unavailable'; status: 503 };
export interface PartnerQuotas { admit(partnerId: string): Promise<{ allowed: true } | QuotaDenial>; }

// An admitted HTTP retry consumes another unit; business idempotency belongs to the downstream owner.
export async function admitPartnerRequest<T extends { allowed: boolean }>(decision: T, partnerId: string, quotas: PartnerQuotas): Promise<T | QuotaDenial> {
  if (!decision.allowed) return decision;
  try {
    const admission = await quotas.admit(partnerId);
    return admission.allowed ? decision : admission;
  } catch { return { allowed: false, error: 'access_unavailable', status: 503 }; }
}
