export type Configuration = {
  clientId: string;
  redirectUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
};

export type Tokens = { accessToken: string; refreshToken: string; expiresAt: number };
export type ProviderSession = Tokens & { email?: string };
export type Principal = { clientId: string; subjectToken: string };
export type LoginTransaction = {
  configuration: Configuration;
  baseUrl: string;
  state: string;
  codeVerifier: string;
  expiresAt: number;
};
export type StoredSession = {
  configuration: Configuration;
  baseUrl: string;
  tokens: Tokens;
  email?: string;
  phase: 'bootstrap' | 'active' | 'logout';
  revocationInstallationId?: string;
};
export type AuthRecord = {
  version: 1;
  transaction: LoginTransaction | null;
  session: StoredSession | null;
};
export const emptyRecord = (): AuthRecord => ({ version: 1, transaction: null, session: null });

export type FailureKind =
  | 'unavailable'
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_callback'
  | 'invalid_response'
  | 'cancelled'
  | 'native_required'
  | 'biometric_locked'
  | 'biometric_unavailable'
  | 'biometric_failed'
  | 'logout_unconfirmed';

export class AuthFailure extends Error {
  constructor(public readonly kind: FailureKind, public readonly traceId?: string) {
    super(kind);
    this.name = 'AuthFailure';
  }
}

export type AuthSnapshot = {
  status: 'loading' | 'signedOut' | 'authorizing' | 'authenticated' | 'blocked' | 'logoutPending' | 'locked' | 'biometricPrompt';
  biometricEnabled?: boolean;
  canEnableBiometrics?: boolean;
  failure?: FailureKind;
  traceId?: string;
  principal?: Principal;
  email?: string;
};
