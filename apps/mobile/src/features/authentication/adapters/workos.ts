import { createWorkOS } from '@workos-inc/node/worker';

import { AuthFailure } from '../domain/session';
import type { Configuration, ProviderSession } from '../domain/session';
import type { IdentityProvider } from '../application/ports';
import { displayEmail, object, text } from './validation';

function client(configuration: Configuration) {
  // The public factory uses FetchHttpClient and forwards timeout, unlike WorkOSWorker in SDK 11.
  const workos = createWorkOS({ clientId: configuration.clientId, timeout: 10_000, maxRetries: 0 });
  if ('hasApiKey' in workos && workos.hasApiKey) throw new AuthFailure('invalid_response');
  return workos;
}

function tokens(response: unknown, configuration: Configuration): ProviderSession {
  const data = object(response);
  const accessToken = text(data.accessToken);
  const refreshToken = text(data.refreshToken);
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) throw new Error();
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = object(JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '='))));
    if (claims.client_id !== configuration.clientId || claims.iss !== `https://api.workos.com/user_management/${configuration.clientId}`
      || typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= Date.now()) throw new Error();
    // Decode only to schedule refresh. Solventa verifies authenticity and authorization.
    const user = data.user && typeof data.user === 'object' ? object(data.user) : undefined;
    const email = user?.emailVerified === true && typeof claims.sub === 'string' && user.id === claims.sub ? displayEmail(user.email) : undefined;
    return { accessToken, refreshToken, expiresAt: claims.exp * 1000, ...(email ? { email } : {}) };
  } catch {
    throw new AuthFailure('invalid_response');
  }
}

async function providerCall(operation: () => Promise<unknown>, configuration: Configuration) {
  try {
    return tokens(await operation(), configuration);
  } catch (error) {
    if (error instanceof AuthFailure) throw error;
    const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    throw new AuthFailure(status === 400 || status === 401 || status === 403 || code === 'invalid_grant' ? 'unauthorized' : 'unavailable');
  }
}

export function createWorkosIdentity(): IdentityProvider {
  return {
    authorize: async configuration => client(configuration).userManagement.getAuthorizationUrlWithPKCE({
      provider: 'authkit', redirectUri: configuration.redirectUri, maxAge: 0,
    }),
    exchange: (configuration, code, codeVerifier) => providerCall(
      () => client(configuration).userManagement.authenticateWithCodeAndVerifier({ code, codeVerifier }), configuration,
    ),
    refresh: (configuration, refreshToken) => providerCall(
      () => client(configuration).userManagement.authenticateWithRefreshToken({ refreshToken }), configuration,
    ),
  };
}

export const workosIdentity = createWorkosIdentity();
