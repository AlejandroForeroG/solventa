import { AuthFailure } from '../domain/session';
import type { AuthRecord, Configuration, Principal, StoredSession, Tokens } from '../domain/session';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthFailure('invalid_response');
  return value as Record<string, unknown>;
}

export function text(value: unknown, max = 16_384): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.trim() !== value) throw new AuthFailure('invalid_response');
  return value;
}

export function displayEmail(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+$/u.test(value) ? value : undefined;
}

export function configuration(value: unknown): Configuration {
  const data = object(value);
  const clientId = text(data.clientId, 128);
  if (!/^client_[a-zA-Z0-9]+$/.test(clientId) || data.redirectUri !== 'solventa://auth/callback'
    || data.authorizationEndpoint !== 'https://api.workos.com/user_management/authorize'
    || data.tokenEndpoint !== 'https://api.workos.com/user_management/authenticate') throw new AuthFailure('invalid_response');
  return { clientId, redirectUri: data.redirectUri, authorizationEndpoint: data.authorizationEndpoint, tokenEndpoint: data.tokenEndpoint };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function trace(value: unknown): string | undefined {
  return typeof value === 'string' && uuid.test(value) ? value : undefined;
}

export function principal(value: unknown): Principal {
  const data = object(value);
  if (!trace(data.clientId) || !trace(data.subjectToken)) throw new AuthFailure('invalid_response');
  return { clientId: text(data.clientId), subjectToken: text(data.subjectToken) };
}

export function tokenPair(value: unknown): Tokens {
  const data = object(value);
  if (typeof data.expiresAt !== 'number' || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= 0) throw new AuthFailure('invalid_response');
  return { accessToken: text(data.accessToken), refreshToken: text(data.refreshToken), expiresAt: data.expiresAt };
}

export function storedRecord(value: unknown): AuthRecord {
  const data = object(value);
  if (data.version !== 1 || (data.session !== null && data.transaction !== null)) throw new AuthFailure('invalid_response');
  let session: StoredSession | null = null;
  if (data.session !== null) {
    const saved = object(data.session);
    if (saved.phase !== 'bootstrap' && saved.phase !== 'active' && saved.phase !== 'logout') throw new AuthFailure('invalid_response');
    session = { configuration: configuration(saved.configuration), baseUrl: text(saved.baseUrl, 512), tokens: tokenPair(saved.tokens), phase: saved.phase };
    const email = displayEmail(saved.email);
    if (email && saved.phase !== 'logout') session.email = email;
    if (saved.revocationInstallationId !== undefined) {
      if (saved.phase !== 'logout' || !trace(saved.revocationInstallationId)) throw new AuthFailure('invalid_response');
      session.revocationInstallationId = text(saved.revocationInstallationId);
    }
  }
  if (data.transaction === null) return { version: 1, session, transaction: null };
  const saved = object(data.transaction);
  const state = text(saved.state, 128);
  const codeVerifier = text(saved.codeVerifier, 128);
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(state) || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)
    || typeof saved.expiresAt !== 'number' || !Number.isSafeInteger(saved.expiresAt)) throw new AuthFailure('invalid_response');
  return { version: 1, session: null, transaction: {
    configuration: configuration(saved.configuration), baseUrl: text(saved.baseUrl, 512), state, codeVerifier, expiresAt: saved.expiresAt,
  } };
}
