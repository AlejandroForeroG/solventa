// An expired session is renewed once through /auth/session and the call is repeated; the business API never refreshes the cookie.
export async function fetchWithSession(input: string, init: RequestInit): Promise<Response> {
  const call = () => fetch(input, { credentials: 'same-origin', ...init });
  const response = await call();
  if (response.status !== 401) return response;
  const renewed = await fetch('/auth/session', { credentials: 'same-origin', signal: init.signal }).then(r => r.ok, () => false);
  return renewed ? call() : response;
}
