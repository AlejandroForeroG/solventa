export type PartnerOfferDenial = 'quota_exceeded' | 'unauthorized' | 'forbidden' | 'consent_required' | 'access_unavailable' | 'invalid_request';

export type PartnerOfferDecision =
  | { allowed: true; partnerId: string; customer: { clientId: string; subjectToken: string }; authorizationExpiresAt: string;
    consent: { consentId: string; textVersion: number; expiresAt: string } }
  | { allowed: false; error: PartnerOfferDenial; retryAfter?: number; status: 400 | 401 | 403 | 429 | 503 };

// Identity decides who the partner is, which customer authorized it and whether that customer's consent is fresh, in one call.
// A failure to verify must block the offer; the customer never comes from the request.
export interface PartnerOfferAccess {
  authorize(input: { token: string; authorizationId: string; traceId: string }): Promise<PartnerOfferDecision>;
}
