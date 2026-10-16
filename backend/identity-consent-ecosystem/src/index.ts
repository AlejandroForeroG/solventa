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
import { authenticationOrigins, configuration } from './adapters/inbound/authentication-http';
import { WorkosMobileAuthentication } from './adapters/outbound/workos-mobile-authentication';
import { MobileSessions } from './application/mobile-sessions';
import { RegisteredDevices } from './application/registered-devices';
import { SqlRegisteredDevices } from './adapters/outbound/registered-devices';
import { authorizeFinancialAccess } from './application/financial-access';
import { SecurityDecisions } from './application/security-decisions';
import { SqlSecurityDecisions } from './adapters/outbound/sql-security-decisions';
import { denyResourceAccess } from './application/resource-access-denials';
import { publishSecurityAlerts } from './application/security-alerts';
import { SqlSecurityAlertOutbox } from './adapters/outbound/security-alert-outbox';
import { CloudflareEmailDelivery } from './adapters/outbound/cloudflare-security-alerts';
import { securityEmailConfiguration } from './adapters/outbound/security-alert-configuration';

function securityFor(env: IdentityEnv) {
  return new SecurityDecisions(new SqlSecurityDecisions(env.IDENTITY_DB.connectionString), () => crypto.randomUUID());
}

async function authorize(env: IdentityEnv, input: unknown): Promise<AccessDecision> {
  try {
    const config = configuration(env);
    const application = new ApiAccess(new SqlPartnerAccess(env.IDENTITY_DB.connectionString), new SqlIdentitySessions(env.IDENTITY_DB.connectionString));
    return await authorizeApiAccess({
      application,
      security: securityFor(env),
      mobile: config ? {
        authenticate: token => new WorkosMobileAuthentication({ clientId: config.clientId, apiKey: config.apiKey }).authenticate(token),
        authorize: (identity, operation) => application.mobileUser(identity, operation),
      } : null,
      partner: env.WORKOS_CONNECT_ISSUER && env.WORKOS_CONNECT_AUDIENCE ? {
        authenticate: token => new WorkosPartnerAuthentication({ issuer: env.WORKOS_CONNECT_ISSUER, audience: env.WORKOS_CONNECT_AUDIENCE }).authenticate(token),
      } : null,
      web: config ? {
        authenticate: (cookie, refresh) => new WorkosAuthentication(config).authenticate(cookie, refresh),
        allowedOrigins: config.local ? [config.origin, 'http://localhost:5173'] : authenticationOrigins(env.APP_ENV),
        // Older Acquisition versions do not send requestOrigin during an Identity-first rollout.
        defaultOrigin: authenticationOrigins(env.APP_ENV).at(-1),
      } : null,
    }, input);
  } catch {
    return { allowed: false, error: 'access_unavailable', status: 503 };
  }
}

// Composition root: platform wiring and operational probes stay outside the core.
type ConsentEnv = IdentityEnv & { CONSENT_SEAL_KEY?: string; SECURITY_ALERT_EMAIL_CONFIG?: string };

async function dispatchSecurityAlerts(env: ConsentEnv) {
  try {
    const config = securityEmailConfiguration(env.SECURITY_ALERT_EMAIL_CONFIG, env.APP_ENV);
    if (!config) return;
    const result = await publishSecurityAlerts({
      outbox: new SqlSecurityAlertOutbox(env.IDENTITY_DB.connectionString),
      delivery: new CloudflareEmailDelivery(env.SECURITY_EMAIL, config),
      now: () => Date.now(), newId: () => crypto.randomUUID(),
    });
    if (result.claimed || result.deadLettered) console.log(JSON.stringify({ event: 'security_alert_dispatch', ...result }));
  } catch {
    console.error(JSON.stringify({ event: 'security_alert_dispatch_failed', code: 'security_alert_unavailable' }));
    throw new Error('security_alert_unavailable');
  }
}

function consentsFor(env: ConsentEnv, audit = true) {
  return new Consents({
    store: new SqlConsents(env.IDENTITY_DB.connectionString),
    platform: { now: () => new Date(), newId: () => crypto.randomUUID() },
    integrity: new HmacIntegrity(env.CONSENT_SEAL_KEY ?? ''),
    security: audit ? securityFor(env) : undefined,
  });
}

export default class extends WorkerEntrypoint<ConsentEnv> {
  async fetch(request: Request): Promise<Response> {
    const config = configuration(this.env);
    const response = await createHttp({
      authorizeApiAccess: input => authorize(this.env, input),
      security: securityFor(this.env),
      authentication: {
        provider: config => new WorkosAuthentication(config),
        sessions: connectionString => new SqlIdentitySessions(connectionString),
      },
      consents: consentsFor(this.env),
      devices: new RegisteredDevices(new SqlRegisteredDevices(this.env.IDENTITY_DB.connectionString), securityFor(this.env)),
      mobile: config ? {
        configuration: { clientId: config.clientId, redirectUri: 'solventa://auth/callback' },
        provider: new WorkosMobileAuthentication({ clientId: config.clientId, apiKey: config.apiKey }),
        sessions: new MobileSessions(new SqlIdentitySessions(this.env.IDENTITY_DB.connectionString)),
      } : null,
    }).fetch(request, this.env, this.ctx);
    const url = new URL(request.url);
    const consentResourceDenial = (response.status === 404 && /^\/api\/v1\/consents\/[^/]+\/revoke$/.test(url.pathname))
      || (response.status === 200 && url.pathname === '/api/v1/consents' && url.searchParams.has('after'));
    if (response.status === 401 || response.status === 403 || consentResourceDenial) this.ctx.waitUntil(dispatchSecurityAlerts(this.env));
    return response;
  }
  async scheduled() { await dispatchSecurityAlerts(this.env); }
  liveness() { return { service: 'identity-consent-ecosystem', environment: this.env.APP_ENV }; }
  async authorizeApiAccessV1(request: ApiAccessRequest) {
    const decision = await authorize(this.env, request);
    if (!decision.allowed && (decision.status === 401 || decision.status === 403)) this.ctx.waitUntil(dispatchSecurityAlerts(this.env));
    return decision;
  }
  async verifyConsentV1(request: ConsentCheck) {
    const decision = await consentsFor(this.env).verify(request);
    if (!decision.allowed) this.ctx.waitUntil(dispatchSecurityAlerts(this.env));
    return decision;
  }
  async authorizeFinancialAccessV1(request: unknown) {
    const decision = await authorizeFinancialAccess({ authorize: input => authorize(this.env, input),
      verifyConsent: input => consentsFor(this.env, false).verify(input), security: securityFor(this.env) }, request);
    if (!decision.allowed && (decision.status === 401 || decision.status === 403)) this.ctx.waitUntil(dispatchSecurityAlerts(this.env));
    return decision;
  }
  async denyResourceAccessV1(request: unknown) {
    const result = await denyResourceAccess(securityFor(this.env), request);
    if (result.recorded) this.ctx.waitUntil(dispatchSecurityAlerts(this.env));
    return result;
  }
  async infraStatus() {
    const probe = await databaseProbe(this.env.IDENTITY_DB.connectionString);
    const database = probe.ready && probe.databaseName === `solventa_${this.env.APP_ENV}`;
    return { service: 'identity-consent-ecosystem', environment: this.env.APP_ENV, databaseName: probe.databaseName, ready: database, database, databaseCode: probe.code };
  }
}
