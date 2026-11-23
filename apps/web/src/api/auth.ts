import { operationalWorkspaces, operationsSessionHeader, type OperationalWorkspace } from '@solventa/contracts';

export type SessionStatus = { status: 'authenticated'; workspaces: readonly OperationalWorkspace[] }
  | { status: 'anonymous' | 'unavailable' };
export type LogoutResult = { status: 'anonymous' } | { status: 'redirect'; logoutUrl: string };

export async function fetchSession(baseUrl = ''): Promise<SessionStatus> {
  try {
    const response = await fetch(`${baseUrl}/auth/session`, {
      credentials: 'same-origin', headers: { [operationsSessionHeader]: 'operations' },
    });
    if (!response.ok) return { status: response.status === 401 ? 'anonymous' : 'unavailable' };
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('authenticated' in body) || body.authenticated !== true) return { status: 'unavailable' };
    const workspaces: unknown = 'workspaces' in body ? body.workspaces : undefined;
    return { status: 'authenticated', workspaces: Array.isArray(workspaces)
      ? operationalWorkspaces.filter(workspace => workspaces.includes(workspace)) : [] };
  } catch { return { status: 'unavailable' }; }
}

export async function requestLogout(baseUrl = ''): Promise<LogoutResult> {
  const response = await fetch(`${baseUrl}/auth/logout`, { method: 'POST', credentials: 'same-origin' });
  if (response.status === 401) return { status: 'anonymous' };
  if (!response.ok) throw new Error('logout_failed');
  const { logoutUrl } = await response.json();
  return { status: 'redirect', logoutUrl };
}
