export type SessionStatus = 'authenticated' | 'anonymous' | 'unavailable';
export type LogoutResult = { status: 'anonymous' } | { status: 'redirect'; logoutUrl: string };

export async function fetchSession(baseUrl = ''): Promise<SessionStatus> {
  try {
    const response = await fetch(`${baseUrl}/auth/session`, { credentials: 'same-origin' });
    return response.ok ? 'authenticated' : response.status === 401 ? 'anonymous' : 'unavailable';
  } catch { return 'unavailable'; }
}

export async function requestLogout(baseUrl = ''): Promise<LogoutResult> {
  const response = await fetch(`${baseUrl}/auth/logout`, { method: 'POST', credentials: 'same-origin' });
  if (response.status === 401) return { status: 'anonymous' };
  if (!response.ok) throw new Error('logout_failed');
  const { logoutUrl } = await response.json();
  return { status: 'redirect', logoutUrl };
}
