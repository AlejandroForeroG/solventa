import type { Evidence, Fixture, Locale, Step, Terms, Verification } from '../domain/verification';

export type VerificationCommand =
  | { action: 'grant'; body: { textVersion: number; locale: Locale } }
  | { action: 'step'; id: string; step: Step; body: Evidence & { expectedVersion: number } }
  | { action: 'evaluate' | 'assistance'; id: string; body: { expectedVersion: number } }
  | { action: 'revoke'; id: string; body: Record<string, never> };
export interface VerificationApi {
  current(): Promise<Verification | null>;
  terms(locale: Locale): Promise<Terms>;
  fixtures(): Promise<Fixture[]>;
  execute(command: VerificationCommand, key: string): Promise<Verification>;
}
export interface AuthenticatedSession {
  execute<T>(operation: (accessToken: string) => Promise<T>): Promise<T>;
}
