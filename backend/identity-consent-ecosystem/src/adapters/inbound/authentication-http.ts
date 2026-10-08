import { getCookie, setCookie } from 'hono/cookie';
import type { Hono, Context } from 'hono';
import { Authentication } from '../../application/authentication';
import { SqlIdentitySessions } from '../outbound/identity-sessions';
import { WorkosAuthentication } from '../outbound/workos-authentication';
import type { AuthConfiguration } from '../outbound/workos-authentication';

type AuthEnv = { Bindings: IdentityEnv };
type Attempt = { state: string; codeVerifier: string; expires: number };
const encoder = new TextEncoder();

// Separate authenticated encryption for the short-lived OAuth transaction.
// It is bound to the configured origin, so callbacks cannot cross environments.
export async function sealAttempt(attempt: Attempt, password: string, origin: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(password + ':oauth')), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(origin) }, key, encoder.encode(JSON.stringify(attempt)));
  return btoa(String.fromCharCode(...iv, ...new Uint8Array(cipher))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
export async function unsealAttempt(value: string, password: string, origin: string): Promise<Attempt | null> {
  try {
    if (value.length > 2000) return null;
    const bytes = Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')), ch => ch.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(password + ':oauth')), 'AES-GCM', false, ['decrypt']);
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0,12), additionalData: encoder.encode(origin) }, key, bytes.slice(12));
    const attempt: Attempt = JSON.parse(new TextDecoder().decode(data));
    if (typeof attempt.state !== 'string' || typeof attempt.codeVerifier !== 'string' || !Number.isFinite(attempt.expires) || attempt.expires <= Date.now()) return null;
    return attempt;
  } catch { return null; }
}
export function configuration(env: IdentityEnv): AuthConfiguration | null {
  if (!env.WORKOS_API_KEY || !env.WORKOS_CLIENT_ID || !env.AUTH_COOKIE_PASSWORD || env.AUTH_COOKIE_PASSWORD.length < 32) return null;
  const origin = env.AUTH_ORIGIN;
  const expected = env.APP_ENV === 'local' ? 'http://localhost:8787' : `https://solventa-web-${env.APP_ENV}.ja-forerog1.workers.dev`;
  if (origin !== expected || env.AUTH_REDIRECT_URI !== origin + '/auth/callback') return null;
  return { apiKey: env.WORKOS_API_KEY, clientId: env.WORKOS_CLIENT_ID, cookiePassword: env.AUTH_COOKIE_PASSWORD, origin, redirectUri: env.AUTH_REDIRECT_URI, local: env.APP_ENV === 'local' };
}
function cookieName(config: AuthConfiguration, attempt = false) { return (config.local ? '' : '__Host-') + (attempt ? 'solventa-oauth' : 'solventa-session'); }
function writeCookie(c: Context<AuthEnv>, config: AuthConfiguration, value: string, attempt = false) {
  setCookie(c, cookieName(config, attempt), value, { httpOnly: true, secure: !config.local, sameSite: 'Lax', path: '/', maxAge: value ? (attempt ? 600 : 604800) : 0 });
}

export function mountAuthentication(app: Hono<AuthEnv>) {
  app.use('/auth/*', async (c, next) => { c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer'); c.header('X-Content-Type-Options', 'nosniff'); await next(); });
  app.all('/auth/*', async c => {
    const config = configuration(c.env);
    if (!config) return c.json({ error: 'authentication_unavailable' }, 503);
    const url = new URL(c.req.url);
    if (url.origin !== config.origin) return c.json({ error: 'invalid_origin' }, 400);
    const path = url.pathname;
    if (!['/auth/login','/auth/callback','/auth/session','/auth/logout'].includes(path)) return c.json({ error: 'not_found' }, 404);
    if (c.req.method !== (path === '/auth/logout' ? 'POST' : 'GET')) return c.json({ error: 'method_not_allowed' }, 405);
    const origins = config.local ? [config.origin, 'http://localhost:5173'] : [config.origin];
    if (path === '/auth/logout' && !origins.includes(c.req.header('Origin') ?? '')) return c.json({ error: 'invalid_origin' }, 403);
    try {
      const provider = new WorkosAuthentication(config);
      const application = new Authentication(new SqlIdentitySessions(c.env.IDENTITY_DB.connectionString));
      if (path === '/auth/login') {
        const begin = await provider.begin();
        writeCookie(c, config, await sealAttempt({ state: begin.state, codeVerifier: begin.codeVerifier, expires: Date.now()+600000 }, config.cookiePassword, config.origin), true);
        return c.redirect(begin.url);
      }
      if (path === '/auth/callback') {
        const attempt = await unsealAttempt(getCookie(c, cookieName(config, true)) ?? '', config.cookiePassword, config.origin);
        writeCookie(c, config, '', true);
        if (!attempt || !url.searchParams.get('state') || url.searchParams.get('state') !== attempt.state || !url.searchParams.get('code')) return c.redirect('/?auth=failed');
        const exchanged = await provider.exchange(url.searchParams.get('code')!, attempt.codeVerifier);
        try { await application.login(exchanged.identity); }
        catch (error) { await provider.revoke(exchanged.identity).catch(() => {}); throw error; }
        writeCookie(c, config, exchanged.cookie);
        return c.redirect('/');
      }
      const cookie = getCookie(c, cookieName(config));
      const verified = cookie ? await provider.authenticate(cookie) : null;
      // A failed refresh from a parallel request must not erase the newer
      // cookie another response has just installed. Invalid cookies grant no access.
      if (!verified) return c.json({ authenticated: false }, 401);
      if (path === '/auth/logout') {
        // Durable local revocation precedes provider logout. A provider outage
        // cannot make the old cookie usable against Solventa again.
        await application.logout(verified.identity);
        writeCookie(c, config, '');
        await provider.revoke(verified.identity).catch(() => {});
        return c.json({ logoutUrl: provider.logoutUrl(verified.identity) });
      }
      const principal = await application.principal(verified.identity);
      if (!principal) { writeCookie(c, config, ''); return c.json({ authenticated: false }, 401); }
      if (verified.cookie) writeCookie(c, config, verified.cookie);
      return c.json({ authenticated: true, principal });
    } catch {
      // Never log provider exceptions: they can contain tokens, email or codes.
      if (path === '/auth/callback') return c.redirect('/?auth=failed');
      return c.json({ error: 'authentication_unavailable' }, 503);
    }
  });
}
