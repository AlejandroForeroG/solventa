import fs from 'node:fs';
import { Verifier } from '@pact-foundation/pact';
import worker from '../../../apps/web/worker/index';
import { createHttp } from '../../../backend/identity-consent-ecosystem/src/adapters/inbound/http';
import { providerName } from './pact-files';
import { serve } from './serve';

const origin = 'https://solventa-web-dev.ja-forerog1.workers.dev';
const identityEnv = {
  APP_ENV: 'dev',
  AUTH_ORIGIN: origin,
  AUTH_REDIRECT_URI: `${origin}/auth/callback`,
  WORKOS_CLIENT_ID: 'client_test',
  WORKOS_API_KEY: 'sk_test_synthetic',
  AUTH_COOKIE_PASSWORD: 'a'.repeat(64),
  IDENTITY_DB: { connectionString: 'postgresql://synthetic.invalid/unused' },
} as IdentityEnv;

type IdentityBinding = { fetch: (request: Request) => Promise<Response> };

// The real Identity app answers the states that need no WorkOS or SQL.
// It only accepts requests addressed to its configured origin, so the test server's address is replaced.
function realIdentity(env: IdentityEnv): IdentityBinding {
  const app = createHttp();
  return {
    fetch: request => {
      const { pathname, search } = new URL(request.url);
      return Promise.resolve(app.request(new Request(origin + pathname + search, request), undefined, env));
    },
  };
}

// WorkOS and SQL are covered by tests/authentication.test.ts and the SQL suites, so a valid session is simulated.
const activeSession: IdentityBinding = {
  fetch: async request => new URL(request.url).pathname === '/auth/logout'
    ? Response.json({ logoutUrl: 'https://auth.example.invalid/logout' })
    : Response.json({ authenticated: true }),
};

const states: Record<string, () => IdentityBinding> = {
  'an active session': () => activeSession,
  'no active session': () => realIdentity(identityEnv),
  'authentication is not configured': () => realIdentity({ ...identityEnv, WORKOS_API_KEY: '' }),
};

export async function verifyPact(pactFile: string): Promise<void> {
  const { provider } = JSON.parse(fs.readFileSync(pactFile, 'utf8'));
  if (provider.name !== providerName) throw new Error(`${pactFile} targets ${provider.name}, not ${providerName}`);
  let identity = states['no active session']();
  const server = await serve(request => worker.fetch(request, { APP_ENV: 'dev', IDENTITY: identity } as unknown as WebEnv));
  try {
    await new Verifier({
      provider: providerName,
      providerBaseUrl: server.url,
      pactUrls: [pactFile],
      stateHandlers: Object.fromEntries(Object.entries(states).map(([state, binding]) => [state, async () => { identity = binding(); }])),
      // Browsers always send Origin on POST, and Identity rejects a logout without it.
      requestFilter: (request, _response, next) => {
        if (request.method === 'POST') request.headers.origin = origin;
        next();
      },
      logLevel: 'error',
    }).verifyProvider();
  } finally {
    await server.close();
  }
}
