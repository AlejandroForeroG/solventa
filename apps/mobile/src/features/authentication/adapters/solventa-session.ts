import { AuthFailure } from '../domain/session';
import type { SessionApi } from '../application/ports';
import { configuration, object, principal, trace } from './validation';

const environments = {
  'https://solventa-web-dev.ja-forerog1.workers.dev': 'client_01M47F52THNNZZZ4WSGACX8KA4',
  'https://solventa-web-staging.ja-forerog1.workers.dev': 'client_01M47F209CBGBJGD73ZM39ADW6',
  'https://solventa-web-prod.ja-forerog1.workers.dev': 'client_01M47F21P884580Q2GGF81NRV5',
};

export function validateBaseUrl(baseUrl: string): string {
  if (!Object.hasOwn(environments, baseUrl)) throw new AuthFailure('invalid_response');
  return baseUrl;
}

export function createSessionApi(baseUrl: string, request: typeof fetch = fetch): SessionApi {
  validateBaseUrl(baseUrl);
  async function call(path: string, method: string, accessToken?: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 12_000;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(6_000, deadline - Date.now())));
      try {
        const response = await request(`${baseUrl}/api/v1${path}`, {
          method, credentials: 'omit', signal: controller.signal,
          headers: { Accept: 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
        });
        const body: unknown = await response.json().catch(() => null);
        if (response.status !== 200) {
          const kind = response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden'
            : response.status === 503 ? 'unavailable' : 'invalid_response';
          const traceId = body && typeof body === 'object' && 'traceId' in body ? trace(body.traceId) : undefined;
          throw new AuthFailure(kind, traceId);
        }
        const data = object(body);
        if (!trace(data.traceId)) throw new AuthFailure('invalid_response');
        return data;
      } catch (error) {
        const failure = error instanceof AuthFailure ? error : new AuthFailure('unavailable');
        if (failure.kind !== 'unavailable' || attempt === 1 || Date.now() >= deadline) throw failure;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new AuthFailure('unavailable');
  }
  async function session(method: 'POST' | 'GET', token: string) {
    const data = await call('/mobile/session', method, token);
    if (data.channel !== 'mobile') throw new AuthFailure('invalid_response');
    return principal(data.principal);
  }
  async function device(method: 'POST' | 'GET' | 'DELETE', token: string, installationId: string) {
    if (!trace(installationId) || installationId[14] !== '4') throw new AuthFailure('invalid_response');
    installationId = installationId.toLowerCase();
    const value = object((await call(`/mobile/devices/${installationId}`, method, token)).device);
    if (!trace(value.id) || value.installationId !== installationId || value.status !== (method === 'DELETE' ? 'revoked' : 'active')) {
      throw new AuthFailure('invalid_response');
    }
  }
  return {
    async configuration() {
      const config = configuration(await call('/mobile/config', 'GET'));
      const expected = Object.entries(environments).find(([url]) => url === baseUrl)?.[1];
      if (config.clientId !== expected) throw new AuthFailure('invalid_response');
      return config;
    },
    register: token => session('POST', token),
    inspect: token => session('GET', token),
    async access(token) {
      const actor = object((await call('/access/mobile', 'GET', token)).actor);
      if (actor.kind !== 'user' || actor.channel !== 'mobile' || !Array.isArray(actor.operations)
        || actor.operations.length !== 1 || actor.operations[0] !== 'quotes:create') throw new AuthFailure('invalid_response');
      return principal(actor.principal);
    },
    async logout(token) {
      if ((await call('/mobile/session', 'DELETE', token)).status !== 'signed_out') throw new AuthFailure('invalid_response');
    },
    registerDevice: (token, installationId) => device('POST', token, installationId),
    inspectDevice: (token, installationId) => device('GET', token, installationId),
    revokeDevice: (token, installationId) => device('DELETE', token, installationId),
  };
}
