/// <reference path="../worker-configuration.d.ts" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createHttp } from './adapters/inbound/http';
import { databaseProbe } from './adapters/outbound/database-probe';
import { authorizeApiAccess } from './adapters/inbound/api-access-http';
import type { ApiAccessRequest } from './adapters/inbound/api-access-http';

import { ApiAccess } from './application/api-access';
import type { AccessDecision } from './application/api-access';
import { SqlIdentitySessions } from './adapters/outbound/identity-sessions';
import { SqlPartnerAccess } from './adapters/outbound/partner-access';
import { WorkosAuthentication } from './adapters/outbound/workos-authentication';
import { WorkosPartnerAuthentication } from './adapters/outbound/workos-partner-authentication';
import { configuration } from './adapters/inbound/authentication-http';

async function authorize(env: IdentityEnv, input: unknown): Promise<AccessDecision> {
  try {
    const config = configuration(env);
    return await authorizeApiAccess({
      application: new ApiAccess(new SqlPartnerAccess(env.IDENTITY_DB.connectionString), new SqlIdentitySessions(env.IDENTITY_DB.connectionString)),
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
export default class extends WorkerEntrypoint<IdentityEnv> {
  async fetch(request: Request): Promise<Response> {
    return createHttp({
      authorizeApiAccess: input => authorize(this.env, input),
      authentication: {
        provider: config => new WorkosAuthentication(config),
        sessions: connectionString => new SqlIdentitySessions(connectionString),
      },
    }).fetch(request, this.env, this.ctx);
  }
  liveness() { return { service: 'identity-consent-ecosystem', environment: this.env.APP_ENV }; }
  async authorizeApiAccessV1(request: ApiAccessRequest) {
    return authorize(this.env, request);
  }
  async infraStatus() {
    const probe = await databaseProbe(this.env.IDENTITY_DB.connectionString);
    const database = probe.ready && probe.databaseName === `solventa_${this.env.APP_ENV}`;
    return { service: 'identity-consent-ecosystem', environment: this.env.APP_ENV, databaseName: probe.databaseName, ready: database, database, databaseCode: probe.code };
  }
}
