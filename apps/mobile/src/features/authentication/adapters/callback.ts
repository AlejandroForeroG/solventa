import { AuthFailure } from '../domain/session';
import type { OAuthCallback } from '../application/ports';

export function parseCallback(raw: string): OAuthCallback {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'solventa:' || url.hostname !== 'auth' || url.pathname !== '/callback'
      || url.username || url.password || url.port || url.hash) throw new Error();
    const state = url.searchParams.getAll('state');
    const code = url.searchParams.getAll('code');
    const error = url.searchParams.getAll('error');
    if (state.length !== 1 || !/^[A-Za-z0-9_-]{43,128}$/.test(state[0])
      || code.length > 1 || error.length > 1 || code.length + error.length !== 1
      || (code.length === 1 && (!code[0] || code[0].length > 4096))
      || (error.length === 1 && (!error[0] || error[0].length > 128))) throw new Error();
    return { state: state[0], code: code[0], error: error[0] };
  } catch {
    throw new AuthFailure('invalid_callback');
  }
}
