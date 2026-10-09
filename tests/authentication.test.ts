import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Authentication } from '../backend/identity-consent-ecosystem/src/application/authentication';
import { sealAttempt, unsealAttempt } from '../backend/identity-consent-ecosystem/src/adapters/inbound/authentication-http';
import { createHttp } from '../backend/identity-consent-ecosystem/src/adapters/inbound/http';
import { WorkosAuthentication } from '../backend/identity-consent-ecosystem/src/adapters/outbound/workos-authentication';
import { SqlIdentitySessions } from '../backend/identity-consent-ecosystem/src/adapters/outbound/identity-sessions';

const password = 'a'.repeat(64);
const origin = 'https://solventa-web-dev.ja-forerog1.workers.dev';
const env = { APP_ENV: 'dev', AUTH_ORIGIN: origin, AUTH_REDIRECT_URI: origin+'/auth/callback', WORKOS_CLIENT_ID: 'client_test', WORKOS_API_KEY: 'sk_test_synthetic', AUTH_COOKIE_PASSWORD: password, IDENTITY_DB: {connectionString:'postgresql://synthetic.invalid/unused'} } as IdentityEnv;
test('unverified identities cannot reach persistence', async () => {
  let called = false;
  const auth = new Authentication({ open: async () => { called=true; throw Error(); }, find: async () => null, revoke: async () => {} });
  await assert.rejects(auth.login({providerSubject:'user_test',sessionReference:'session_test',emailVerified:false}),/identity_unverified/);
  assert.equal(called,false);
});
test('OAuth transaction is encrypted, expires and cannot cross environments', async () => {
  const attempt = {state:'synthetic-state',codeVerifier:'synthetic-verifier',expires:Date.now()+60000};
  const cookie = await sealAttempt(attempt,password,origin);
  assert.ok(!cookie.includes(attempt.codeVerifier));
  assert.deepEqual(await unsealAttempt(cookie,password,origin),attempt);
  assert.equal(await unsealAttempt(cookie,password,'https://solventa-web-prod.ja-forerog1.workers.dev'),null);
  assert.equal(await unsealAttempt(cookie,'b'.repeat(64),origin),null);
  assert.equal(await unsealAttempt(cookie.slice(0,-8),password,origin),null);
  assert.equal(await unsealAttempt(await sealAttempt({...attempt,expires:Date.now()-1},password,origin),password,origin),null);
});
test('missing session, forged callback, CSRF and wrong methods fail closed', async () => {
  const app=createHttp({ authorizeApiAccess: async () => assert.fail('unexpected_business_authorization'), authentication: { provider: config => new WorkosAuthentication(config), sessions: url => new SqlIdentitySessions(url) } });
  assert.equal((await app.request(origin+'/auth/session',{},env)).status,401);
  const invalidSession=await app.request(origin+'/auth/session',{headers:{Cookie:'__Host-solventa-session=forged_cookie'}},env);
  assert.equal(invalidSession.status,401);
  assert.equal(invalidSession.headers.get('set-cookie'),null,'A stale response must not clear a newer cookie');
  assert.equal((await app.request(origin+'/auth/logout',{method:'POST',headers:{Origin:'https://attacker.invalid'}},env)).status,403);
  assert.equal((await app.request(origin+'/auth/logout',{},env)).status,405);
  assert.equal((await app.request('https://attacker.invalid/auth/session',{},env)).status,400);
  assert.equal((await app.request(origin+'/auth/login',{}, {...env,WORKOS_API_KEY:''})).status,503);
  const callback=await app.request(origin+'/auth/callback?code=forged&state=forged',{},env);
  assert.equal(callback.status,302);
  assert.equal(callback.headers.get('location'),'/?auth=failed');
  assert.match(callback.headers.get('set-cookie')??'',/__Host-solventa-oauth=.*HttpOnly.*Secure.*SameSite=Lax/i);
  assert.equal(callback.headers.get('cache-control'),'no-store');
});
test('authorization uses SDK PKCE and token cookies fail validation', async () => {
  const provider=new WorkosAuthentication({apiKey:env.WORKOS_API_KEY,clientId:env.WORKOS_CLIENT_ID,cookiePassword:password,origin,redirectUri:origin+'/auth/callback',local:false});
  const flow=await provider.begin();
  const url=new URL(flow.url);
  assert.equal(url.searchParams.get('redirect_uri'),origin+'/auth/callback');
  assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  assert.ok(flow.codeVerifier.length>=43);
  assert.equal(await provider.authenticate('forged_cookie'),null);
});
