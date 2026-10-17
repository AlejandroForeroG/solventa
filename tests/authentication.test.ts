import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Authentication } from '../backend/identity-consent-ecosystem/src/application/authentication';
import { configuration, sealAttempt, unsealAttempt } from '../backend/identity-consent-ecosystem/src/adapters/inbound/authentication-http';
import { createHttp } from '../backend/identity-consent-ecosystem/src/adapters/inbound/http';
import { WorkosAuthentication } from '../backend/identity-consent-ecosystem/src/adapters/outbound/workos-authentication';
import { SqlIdentitySessions } from '../backend/identity-consent-ecosystem/src/adapters/outbound/identity-sessions';

const password = 'a'.repeat(64);
const origin = 'https://solventa-web-dev.ja-forerog1.workers.dev';
const env = { APP_ENV: 'dev', AUTH_ORIGIN: origin, AUTH_REDIRECT_URI: origin+'/auth/callback', WORKOS_CLIENT_ID: 'client_test', WORKOS_API_KEY: 'sk_test_synthetic', AUTH_COOKIE_PASSWORD: password, IDENTITY_DB: {connectionString:'postgresql://synthetic.invalid/unused'} } as IdentityEnv;

test('each environment accepts exactly its canonical and legacy hosts and rejects foreign configuration', async () => {
  for (const [environment, canonical] of [['dev', 'https://dev.solventa.site'], ['staging', 'https://staging.solventa.site'], ['prod', 'https://solventa.site']] as const) {
    const legacy = `https://solventa-web-${environment}.ja-forerog1.workers.dev`;
    const bindings = { ...env, APP_ENV: environment, AUTH_ORIGIN: canonical, AUTH_REDIRECT_URI: canonical + '/auth/callback' } as IdentityEnv;
    for (const host of [canonical, legacy]) {
      assert.equal(configuration(bindings, host)?.redirectUri, host + '/auth/callback');
    }
    for (const host of ['https://attacker.invalid', canonical + '.attacker.invalid', canonical + ':8443', canonical.replace('https:', 'http:'), 'https://other.solventa.site', ...['https://dev.solventa.site', 'https://staging.solventa.site', 'https://solventa.site'].filter(value => value !== canonical)]) {
      assert.equal(configuration(bindings, host), null, host);
    }
    assert.equal(configuration({ ...bindings, AUTH_REDIRECT_URI: legacy + '/auth/callback' } as IdentityEnv), null);
    assert.equal(configuration({ ...bindings, AUTH_ORIGIN: 'https://attacker.invalid', AUTH_REDIRECT_URI: 'https://attacker.invalid/auth/callback' } as IdentityEnv), null);
  }
});

test('both aliases use their own PKCE callback and host-only cookie; foreign hosts never reach the provider', async () => {
  const canonical = 'https://dev.solventa.site';
  const bindings = { ...env, AUTH_ORIGIN: canonical, AUTH_REDIRECT_URI: canonical + '/auth/callback' } as IdentityEnv;
  const app = createHttp({ authorizeApiAccess: async () => assert.fail('unexpected_access'), authentication: {
    provider: config => new WorkosAuthentication(config), sessions: () => ({ open: async () => assert.fail('unexpected_persistence'), find: async () => assert.fail('unexpected_persistence'), revoke: async () => assert.fail('unexpected_persistence') }),
  } });
  for (const host of [canonical, origin]) {
    const response = await app.request(host + '/auth/login', {}, bindings);
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get('location')!).searchParams.get('redirect_uri'), host + '/auth/callback');
    const cookie = response.headers.get('set-cookie') ?? '';
    assert.match(cookie, /__Host-solventa-oauth=.*Path=\/.*HttpOnly.*Secure.*SameSite=Lax/i);
    assert.doesNotMatch(cookie, /Domain=/i);
    const sealed = cookie.split(';')[0].split('=').slice(1).join('=');
    assert.ok(await unsealAttempt(sealed, password, host));
    assert.equal(await unsealAttempt(sealed, password, host === canonical ? origin : canonical), null);
  }
  assert.equal((await app.request('https://staging.solventa.site/auth/login', {}, bindings)).status, 400);
});

test('same-environment aliases cannot submit cross-host logout or exchange one another\'s OAuth attempt', async () => {
  const canonical = 'https://dev.solventa.site';
  const bindings = { ...env, AUTH_ORIGIN: canonical, AUTH_REDIRECT_URI: canonical + '/auth/callback' } as IdentityEnv;
  const app = createHttp({ authorizeApiAccess: async () => assert.fail('unexpected_access'), authentication: {
    provider: () => assert.fail('cross-host request reached provider'), sessions: () => assert.fail('cross-host request reached SQL'),
  } });
  for (const [target, source] of [[canonical, origin], [origin, canonical]]) {
    const response = await app.request(target + '/auth/logout', { method: 'POST', headers: { Origin: source, Cookie: '__Host-solventa-session=synthetic' } }, bindings);
    assert.equal(response.status, 403);
  }
  let exchanges = 0;
  const callbackApp = createHttp({ authorizeApiAccess: async () => assert.fail('unexpected_access'), authentication: {
    provider: () => ({ begin: async () => assert.fail(), exchange: async () => { exchanges++; return assert.fail(); }, authenticate: async () => null, revoke: async () => {}, logoutUrl: () => '' }),
    sessions: () => ({ open: async () => assert.fail(), find: async () => null, revoke: async () => {} }),
  } });
  const attempt = await sealAttempt({ state: 'state', codeVerifier: 'verifier', expires: Date.now() + 60000 }, password, origin);
  const response = await callbackApp.request(canonical + '/auth/callback?state=state&code=synthetic', { headers: { Cookie: '__Host-solventa-oauth=' + attempt } }, bindings);
  assert.equal(response.headers.get('location'), '/?auth=failed');
  assert.equal(exchanges, 0);
});

test('callback persistence, session and logout remain functional on each alias with provider and SQL fakes', async () => {
  const canonical = 'https://dev.solventa.site';
  const bindings = { ...env, AUTH_ORIGIN: canonical, AUTH_REDIRECT_URI: canonical + '/auth/callback' } as IdentityEnv;
  const identity = { providerSubject: 'user_synthetic', sessionReference: 'session_synthetic', emailVerified: true };
  const principal = { clientId: crypto.randomUUID(), subjectToken: crypto.randomUUID() };
  for (const host of [canonical, origin]) {
    const calls: string[] = [];
    const app = createHttp({ authorizeApiAccess: async () => assert.fail('unexpected_access'), authentication: {
      provider: config => {
        assert.equal(config.origin, host);
        assert.equal(config.redirectUri, host + '/auth/callback');
        return { begin: async () => assert.fail('unexpected_begin'), exchange: async (code, verifier) => { assert.equal(code, 'synthetic'); assert.equal(verifier, 'verifier'); calls.push('exchange'); return { identity, cookie: 'sealed_session' }; },
          authenticate: async cookie => { assert.equal(cookie, 'sealed_session'); return { identity }; }, revoke: async () => { calls.push('provider_logout'); }, logoutUrl: () => host + '/?logged-out' };
      },
      sessions: () => ({ open: async () => { calls.push('persist'); return principal; }, find: async () => principal, revoke: async () => { calls.push('local_logout'); } }),
    } });
    const attempt = await sealAttempt({ state: 'state', codeVerifier: 'verifier', expires: Date.now() + 60000 }, password, host);
    const callback = await app.request(host + '/auth/callback?state=state&code=synthetic', { headers: { Cookie: '__Host-solventa-oauth=' + attempt } }, bindings);
    assert.equal(callback.headers.get('location'), '/');
    assert.match(callback.headers.get('set-cookie') ?? '', /__Host-solventa-session=sealed_session/);
    assert.doesNotMatch(callback.headers.get('set-cookie') ?? '', /Domain=/i);
    assert.deepEqual(calls, ['exchange', 'persist']);
    const session = await app.request(host + '/auth/session', { headers: { Cookie: '__Host-solventa-session=sealed_session' } }, bindings);
    assert.deepEqual(await session.json(), { authenticated: true, principal });
    const logout = await app.request(host + '/auth/logout', { method: 'POST', headers: { Origin: host, Cookie: '__Host-solventa-session=sealed_session' } }, bindings);
    assert.deepEqual(await logout.json(), { logoutUrl: host + '/?logged-out' });
    assert.deepEqual(calls, ['exchange', 'persist', 'local_logout', 'provider_logout']);
  }
});
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

test('web logout forwards its request correlation and stops provider logout after a local failure', async () => {
  const identity = { providerSubject: 'user_shared', sessionReference: 'session_shared', emailVerified: true };
  for (const [trace, failLocal] of [['00000000-0000-4000-8000-000000000007', false], ['ABCDEF12-3456-4789-8ABC-DEF012345678', false], ['invalid', false], ['00000000-0000-4000-8000-000000000007', true]] as const) {
    const calls: string[] = [];
    let localTrace: string | undefined;
    const app = createHttp({ authorizeApiAccess: async () => assert.fail('unexpected_access'), authentication: {
      provider: () => ({ begin: async () => assert.fail('unexpected_login'), exchange: async () => assert.fail('unexpected_exchange'),
        authenticate: async () => ({ identity }), revoke: async () => { calls.push('provider'); }, logoutUrl: () => 'https://synthetic.example/logout' }),
      sessions: () => ({ open: async () => assert.fail('unexpected_registration'), find: async () => null,
        revoke: async (verified, correlation) => { assert.deepEqual(verified, identity); localTrace = correlation; calls.push('local'); if (failLocal) throw new Error('sql_offline'); } }),
    } });
    const response = await app.request(origin + '/auth/logout', { method: 'POST', headers: { Origin: origin, Cookie: '__Host-solventa-session=synthetic', 'X-Trace-Id': trace } }, env);
    assert.equal(response.status, failLocal ? 503 : 200);
    assert.equal(localTrace, response.headers.get('x-trace-id'));
    assert.match(localTrace ?? '', /^[0-9a-f-]{36}$/i);
    if (trace !== 'invalid') assert.equal(localTrace, trace.toLowerCase());
    assert.deepEqual(calls, failLocal ? ['local'] : ['local', 'provider']);
    assert.deepEqual(await response.json(), failLocal ? { error: 'authentication_unavailable' } : { logoutUrl: 'https://synthetic.example/logout' });
    if (failLocal) assert.equal(response.headers.get('set-cookie'), null);
  }
});
