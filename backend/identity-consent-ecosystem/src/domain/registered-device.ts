export type DeviceAction = 'register' | 'find' | 'revoke';
export type RegisteredDevice = { id: string; installationId: string; status: 'active' | 'revoked' };
export type DeviceBinding = { id: string; installationId: string; revoked: boolean; registeredAt?: number };
export type DeviceSnapshot = {
  observedAt: number;
  authenticatedAt?: number;
  session: { clientActive: boolean; createdAt: number; expiresAt: number; revoked: boolean } | null;
  bindings: DeviceBinding[];
};
export type DeviceDecision =
  | { effect: 'register' }
  | { effect: 'replace'; previous: DeviceBinding[] }
  | { effect: 'revoke'; device: RegisteredDevice }
  | { effect: 'none'; device: RegisteredDevice }
  | { effect: 'deny'; reason: 'session_unavailable' | 'binding_unavailable' | 'binding_revoked' | 'installation_replacement' | 'registration_window_expired'; record: boolean };

export const deviceRegistrationWindowMs = 10 * 60 * 1000;
export const devicePolicy = { id: 'session-bound-installation', version: '4' } as const;
export const deviceLogoutPolicy = { id: 'session-device-logout', version: '1' } as const;
export function canonicalInstallationId(value: string): string { return value.toLowerCase(); }

export function decideDeviceOperation(action: DeviceAction, installationId: string, snapshot: DeviceSnapshot): DeviceDecision {
  installationId = canonicalInstallationId(installationId);
  const session = snapshot.session;
  if (!session || (action !== 'revoke' && (!session.clientActive || session.revoked || session.expiresAt <= snapshot.observedAt))) {
    return { effect: 'deny', reason: 'session_unavailable', record: false };
  }
  const binding = snapshot.bindings.find(value => canonicalInstallationId(value.installationId) === installationId);
  if (action === 'register') {
    if (binding?.revoked) return { effect: 'deny', reason: 'binding_revoked', record: true };
    if (!binding) {
      const authenticatedAt = snapshot.authenticatedAt;
      const recentAuthentication = authenticatedAt !== undefined && Number.isSafeInteger(authenticatedAt)
        && authenticatedAt <= snapshot.observedAt && authenticatedAt > snapshot.observedAt - deviceRegistrationWindowMs;
      if (snapshot.bindings.length) {
        // Fresh token issuance/refresh is not reauthentication. Consume only authentication newer than every binding.
        if (!recentAuthentication || snapshot.bindings.some(value => value.registeredAt === undefined || authenticatedAt <= value.registeredAt)) {
          return { effect: 'deny', reason: 'installation_replacement', record: true };
        }
        return { effect: 'replace', previous: snapshot.bindings.filter(value => !value.revoked) };
      }
      if (!recentAuthentication && session.createdAt <= snapshot.observedAt - deviceRegistrationWindowMs) {
        return { effect: 'deny', reason: 'registration_window_expired', record: true };
      }
      return { effect: 'register' };
    }
  }
  if (!binding || (action === 'find' && binding.revoked)) return { effect: 'deny', reason: 'binding_unavailable', record: false };
  // A replaced installation cannot log out the replacement through a stale DELETE retry.
  if (action === 'revoke' && binding.revoked && snapshot.bindings.some(value => !value.revoked)) {
    return { effect: 'deny', reason: 'binding_unavailable', record: false };
  }
  const device: RegisteredDevice = { id: binding.id, installationId, status: action === 'revoke' ? 'revoked' : 'active' };
  return { effect: action === 'revoke' && !binding.revoked ? 'revoke' : 'none', device };
}
