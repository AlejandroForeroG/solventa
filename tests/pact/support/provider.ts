import fs from 'node:fs';
import { Verifier } from '@pact-foundation/pact';
import worker from '../../../apps/web/worker/index';
import { createHttp as createAcquisitionHttp } from '../../../backend/acquisition-risk/src/adapters/inbound/http';
import { CreateQuote } from '../../../backend/acquisition-risk/src/application/create-quote';
import type { AuthenticationCollaborators } from '../../../backend/identity-consent-ecosystem/src/adapters/inbound/authentication-http';
import { createHttp as createIdentityHttp } from '../../../backend/identity-consent-ecosystem/src/adapters/inbound/http';
import { InMemoryAccess, MemoryStore, protector } from '../../support/quote-fakes';
import { providerName } from './pact-files';
import { serve } from './serve';

const origin = 'https://solventa-web-dev.ja-forerog1.workers.dev';
const sessionCookieName = '__Host-solventa-session';
const identityEnv = {
  APP_ENV: 'dev',
  AUTH_ORIGIN: origin,
  AUTH_REDIRECT_URI: `${origin}/auth/callback`,
  WORKOS_CLIENT_ID: 'client_test',
  WORKOS_API_KEY: 'sk_test_synthetic',
  AUTH_COOKIE_PASSWORD: 'a'.repeat(64),
  IDENTITY_DB: { connectionString: 'postgresql://synthetic.invalid/unused' },
} as IdentityEnv;

type Binding = { fetch: (request: Request) => Promise<Response> };
type World = { identity: Binding; acquisition: Binding; sessionCookie?: string };

// The real Identity app answers every state. It only accepts requests addressed to its configured origin,
// so the test server's address is replaced.
function realIdentity(env: IdentityEnv, authentication?: AuthenticationCollaborators): Binding {
  const app = createIdentityHttp({ authorizeApiAccess: async () => { throw new Error('unexpected_business_authorization'); }, authentication });
  return {
    fetch: request => {
      const { pathname, search } = new URL(request.url);
      return Promise.resolve(app.request(new Request(origin + pathname + search, request), undefined, env));
    },
  };
}

// The routes are real; only WorkOS and SQL are replaced for a valid session, because they need credentials and a database.
// Their own behavior is covered by tests/authentication.test.ts and the SQL suites.
const activeSessionCookie = 'active-session';
const identity = { providerSubject: 'user_synthetic', sessionReference: 'session_synthetic', emailVerified: true };
const activeSessionProvider: AuthenticationCollaborators = {
  provider: () => ({
    authenticate: async cookie => (cookie === activeSessionCookie ? { identity } : null),
    revoke: async () => {},
    logoutUrl: () => 'https://auth.example.invalid/logout',
    begin: async () => { throw new Error('unexpected_login'); },
    exchange: async () => { throw new Error('unexpected_callback'); },
  }),
  sessions: () => ({
    find: async () => ({ clientId: crypto.randomUUID(), subjectToken: crypto.randomUUID() }),
    revoke: async () => {},
    open: async () => { throw new Error('unexpected_session_registration'); },
  }),
};

// The real quote handler and use case run with the in-memory access and store the HTTP tests use.
// Identity's decision is simulated by the cookie value; its verification is covered by the access suites.
function realAcquisition(store = new MemoryStore()): Binding {
  const quotes = new CreateQuote({ access: new InMemoryAccess(), store, clock: { now: () => new Date('2026-10-06T15:00:00Z') }, protector });
  const app = createAcquisitionHttp({ quotes });
  return { fetch: request => Promise.resolve(app.request(request, undefined, { APP_ENV: 'dev' } as AcquisitionEnv)) };
}

const unavailableService: Binding = { fetch: async () => { throw new Error('service_down'); } };

const seedQuoteRequest = {
  product: 'vida_hipotecario',
  customer: { fullName: 'Laura Catalina Restrepo Ochoa', documentType: 'CC', documentNumber: '1020884771', birthDate: '1992-03-14', city: 'Bogotá D.C.' },
  credit: { partnerCreditId: 'CRE-88-2026', amount: 320000000, termMonths: 180 },
};

async function acquisitionWithQuote(idempotencyKey: string, cookie: string): Promise<Binding> {
  const acquisition = realAcquisition();
  await acquisition.fetch(new Request(`${origin}/api/v1/me/quotes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, cookie: `${sessionCookieName}=${cookie}` },
    body: JSON.stringify(seedQuoteRequest),
  }));
  return acquisition;
}

const authorizedCookie = 'sealed-cookie';

type StateParameters = { idempotencyKey?: string } | undefined;
const states: Record<string, (parameters: StateParameters) => Promise<Partial<World>> | Partial<World>> = {
  'an active session': () => ({ identity: realIdentity(identityEnv, activeSessionProvider), sessionCookie: activeSessionCookie }),
  'no active session': () => ({}),
  'authentication is not configured': () => ({ identity: realIdentity({ ...identityEnv, WORKOS_API_KEY: '' }) }),
  'a customer with quote access': () => ({ sessionCookie: authorizedCookie }),
  'a customer without permission to quote': () => ({ sessionCookie: 'forbidden-origin-cookie' }),
  'the idempotency key was used with another request': async parameters => ({
    sessionCookie: authorizedCookie,
    acquisition: await acquisitionWithQuote(parameters?.idempotencyKey ?? '', authorizedCookie),
  }),
  'the quote service is down': () => ({ sessionCookie: authorizedCookie, acquisition: unavailableService }),
};

const defaultWorld = (): World => ({ identity: realIdentity(identityEnv), acquisition: realAcquisition() });

export async function verifyPact(pactFile: string): Promise<void> {
  const { provider } = JSON.parse(fs.readFileSync(pactFile, 'utf8'));
  if (provider.name !== providerName) throw new Error(`${pactFile} targets ${provider.name}, not ${providerName}`);
  let world = defaultWorld();
  const server = await serve(request => worker.fetch(request, {
    APP_ENV: 'dev',
    get IDENTITY() { return world.identity; },
    get ACQUISITION() { return world.acquisition; },
  } as unknown as WebEnv));
  try {
    await new Verifier({
      provider: providerName,
      providerBaseUrl: server.url,
      pactUrls: [pactFile],
      stateHandlers: Object.fromEntries(Object.entries(states).map(([state, build]) => [state, async (parameters?: unknown) => {
        world = { ...defaultWorld(), ...await build(parameters as StateParameters) };
      }])),
      // The browser sends Origin on POST and the session cookie on same-origin requests; the contract does not carry them.
      requestFilter: (request, _response, next) => {
        if (request.method === 'POST') request.headers.origin = origin;
        if (world.sessionCookie && /^\/(api|auth)\//.test(request.url)) request.headers.cookie = `${sessionCookieName}=${world.sessionCookie}`;
        next();
      },
      logLevel: 'error',
    }).verifyProvider();
  } finally {
    await server.close();
  }
}
