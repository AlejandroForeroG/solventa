export type AccessCredential =
  | { kind: 'partner'; token: string }
  | { kind: 'web'; cookie: string; origin: string; method: string };

export type QuoteActor =
  | { kind: 'partner'; partnerId: string }
  | { kind: 'user'; clientId: string; subjectToken: string };

export type AccessDenial = 'unauthorized' | 'forbidden' | 'access_unavailable';

export type AccessDecision =
  | { allowed: true; actor: QuoteActor }
  | { allowed: false; error: AccessDenial; status: 401 | 403 | 503 };

// Identity owns authentication and permissions. A failure to verify must block the quote.
export interface ApiAccess {
  authorize(credential: AccessCredential): Promise<AccessDecision>;
}
