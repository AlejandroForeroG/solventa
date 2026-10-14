export type DeviceAction = 'register' | 'find' | 'revoke';
export type RegisteredDevice = { id: string; installationId: string; status: 'active' | 'revoked' };
export type DeviceBinding = { id: string; installationId: string; revoked: boolean };
export type DeviceSnapshot = {
  observedAt: number;
  session: { clientActive: boolean; createdAt: number; expiresAt: number; revoked: boolean } | null;
  bindings: DeviceBinding[];
};
export type DeviceDecision =
  | { effect: 'register' }
  | { effect: 'revoke'; device: RegisteredDevice }
  | { effect: 'none'; device: RegisteredDevice }
  | { effect: 'deny'; reason: 'session_unavailable' | 'binding_unavailable' | 'binding_revoked' | 'installation_replacement' | 'registration_window_expired'; record: boolean };

export const deviceRegistrationWindowMs = 10 * 60 * 1000;
export const devicePolicy = { id: 'session-bound-installation', version: '3' } as const;
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
      if (snapshot.bindings.length) return { effect: 'deny', reason: 'installation_replacement', record: true };
      if (session.createdAt <= snapshot.observedAt - deviceRegistrationWindowMs) {
        return { effect: 'deny', reason: 'registration_window_expired', record: true };
      }
      return { effect: 'register' };
    }
  }
  if (!binding || (action === 'find' && binding.revoked)) return { effect: 'deny', reason: 'binding_unavailable', record: false };
  const device: RegisteredDevice = { id: binding.id, installationId, status: action === 'revoke' ? 'revoked' : 'active' };
  return { effect: action === 'revoke' && !binding.revoked ? 'revoke' : 'none', device };
}
