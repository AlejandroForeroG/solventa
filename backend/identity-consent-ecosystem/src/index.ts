/// <reference path="../worker-configuration.d.ts" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createHttp } from './adapters/inbound/http';
import { databaseProbe } from './adapters/outbound/database-probe';
import { authorizeApiAccess } from './adapters/inbound/api-access-http';
import type { ApiAccessRequest } from './adapters/inbound/api-access-http';

import { ApiAccess } from './application/api-access';
import { Consents } from './application/consents';
import type { ConsentCheck } from './application/consents';
import { HmacIntegrity } from './adapters/outbound/hmac-integrity';
import { SqlConsents } from './adapters/outbound/sql-consents';
import type { AccessDecision } from './application/api-access';
import { SqlIdentitySessions } from './adapters/outbound/identity-sessions';
import { SqlPartnerAccess } from './adapters/outbound/partner-access';
import { WorkosAuthentication } from './adapters/outbound/workos-authentication';
import { WorkosPartnerAuthentication } from './adapters/outbound/workos-partner-authentication';
import { configuration } from './adapters/inbound/authentication-http';
import { WorkosMobileAuthentication } from './adapters/outbound/workos-mobile-authentication';
import { MobileSessions } from './application/mobile-sessions';

async function authorize(env: IdentityEnv, input: unknown): Promise<AccessDecision> {
  try {
    const config = configuration(env);
    const application = new ApiAccess(new SqlPartnerAccess(env.IDENTITY_DB.connectionString), new SqlIdentitySessions(env.IDENTITY_DB.connectionString));
    return await authorizeApiAccess({
      application,
      mobile: config ? {
        authenticate: token => new WorkosMobileAuthentication({ clientId: config.clientId, apiKey: config.apiKey }).authenticate(token),
        authorize: (identity, operation) => application.mobileUser(identity, operation),
      } : null,
      partner: env.WORKOS_CONNECT_ISSUER && env.WORKOS_CONNECT_AUDIENCE ? {
        authenticate: token => new WorkosPartnerAuthentication({ issuer: env.WORKOS_CONNECT_ISSUER, audience: env.WORKOS_CONNECT_AUDIENCE }).authenticate(token),
      } : null,
      web: config ? {
        authenticate: (cookie, refresh) => new WorkosAuthentication(config).authenticate(cookie, refresh),
        allowedOrigins: config.local ? [config.origin, 'http://localhost:5173'] : [config.origin],
      } : null,
    }, input);
  } catch {
    return { allowed: false, error: 'access_unavailable', status: 503 };
  }
}

// Composition root: platform wiring and operational probes stay outside the core.
type ConsentEnv = IdentityEnv & { CONSENT_SEAL_KEY?: string };

function consentsFor(env: ConsentEnv) {
  return new Consents({
    store: new SqlConsents(env.IDENTITY_DB.connectionString),
    platform: { now: () => new Date(), newId: () => crypto.randomUUID() },
    integrity: new HmacIntegrity(env.CONSENT_SEAL_KEY ?? '')
  });
}

export default class extends WorkerEntrypoint<ConsentEnv> {
  async fetch(request: Request): Promise<Response> {
    const config = configuration(this.env);
    return createHttp({
      authorizeApiAccess: input => authorize(this.env, input),
      authentication: {
        provider: config => new WorkosAuthentication(config),
        sessions: connectionString => new SqlIdentitySessions(connectionString),
      },
      consents: consentsFor(this.env),
      mobile: config ? {
        configuration: { clientId: config.clientId, redirectUri: 'solventa://auth/callback' },
        provider: new WorkosMobileAuthentication({ clientId: config.clientId, apiKey: config.apiKey }),
        sessions: new MobileSessions(new SqlIdentitySessions(this.env.IDENTITY_DB.connectionString)),
      } : null,
    }).fetch(request, this.env, this.ctx);
  }
  liveness() { return { service: 'identity-consent-ecosystem', environment: this.env.APP_ENV }; }
  async authorizeApiAccessV1(request: ApiAccessRequest) {
    return authorize(this.env, request);
  }
  async verifyConsentV1(request: ConsentCheck) {
    return consentsFor(this.env).verify(request);
  }
  async infraStatus() {
    const probe = await databaseProbe(this.env.IDENTITY_DB.connectionString);
    const database = probe.ready && probe.databaseName === `solventa_${this.env.APP_ENV}`;
    return { service: 'identity-consent-ecosystem', environment: this.env.APP_ENV, databaseName: probe.databaseName, ready: database, database, databaseCode: probe.code };
  }
}
