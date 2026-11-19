export type AdvisorSaleDenial = 'unauthorized' | 'forbidden' | 'consent_required' | 'access_unavailable' | 'invalid_request';

export type AdvisorSaleDecision =
  | { allowed: true; advisorReference: string; customer: { clientId: string; subjectToken: string }; authorizationExpiresAt: string;
    consent: { consentId: string; textVersion: number; expiresAt: string } }
  | { allowed: false; error: AdvisorSaleDenial; status: 400 | 401 | 403 | 503 };

// The advisor's own web session, as the browser sent it. Identity verifies it; the customer never comes from the request.
export type AdvisorSessionCredential = { cookie: string; origin: string; requestOrigin: string; method: string };

// Identity decides who the advisor is, which customer authorized that advisor and whether that customer's consent is fresh, in one call.
// A failure to verify must block the offer.
export interface AdvisorSaleAccess {
  authorize(input: { session: AdvisorSessionCredential; authorizationId: string; traceId: string }): Promise<AdvisorSaleDecision>;
}
