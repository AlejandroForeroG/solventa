import type { AuthRecord, Configuration, Principal, ProviderSession } from '../domain/session';

export type OAuthCallback = { state: string; code?: string; error?: string };
export interface TokenStore {
  read(): Promise<AuthRecord>;
  write(record: AuthRecord): Promise<void>;
}
export interface IdentityProvider {
  authorize(configuration: Configuration): Promise<{ url: string; state: string; codeVerifier: string }>;
  exchange(configuration: Configuration, code: string, codeVerifier: string): Promise<ProviderSession>;
  refresh(configuration: Configuration, refreshToken: string): Promise<ProviderSession>;
}
export interface SessionApi {
  configuration(): Promise<Configuration>;
  register(accessToken: string): Promise<Principal>;
  inspect(accessToken: string): Promise<Principal>;
  access(accessToken: string): Promise<Principal>;
  logout(accessToken: string): Promise<void>;
  registerDevice(accessToken: string, installationId: string): Promise<void>;
  inspectDevice(accessToken: string, installationId: string): Promise<void>;
  revokeDevice(accessToken: string, installationId: string): Promise<void>;
}
export interface BiometricVault {
  info(): Promise<{ installationId: string; baseUrl: string; owner?: Principal; suspended?: boolean } | null>;
  suspend(): Promise<void>;
  resume(): Promise<boolean>;
  prepare(record: AuthRecord): Promise<string>;
  commit(installationId: string, baseUrl: string, owner: Principal): Promise<void>;
  unlock(): Promise<AuthRecord>;
  clear(): Promise<void>;
}
export interface AuthBrowser {
  assertAvailable(): void;
  open(url: string, callback: string): Promise<string | null>;
}
