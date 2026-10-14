import type { VerifiedIdentity } from './authentication';

export type RegisteredDevice = { id: string; installationId: string; status: 'active' | 'revoked' };
export type DeviceOperation = {
  identity: VerifiedIdentity; installationId: string; correlationId: string;
  capture?: {
    schemaVersion: 1; contractVersion: string; correlationId: string;
    inputs: { action: string; installationId: string; sessionBound: boolean };
    sources: { source: string; capturedAt: string; quality: string }[];
    consent: { status: 'not_required' }; rule: { id: string; version: string }; outcome: string;
  };
};
export interface DeviceStore {
  register(input: DeviceOperation): Promise<RegisteredDevice | null>;
  find(input: DeviceOperation): Promise<RegisteredDevice | null>;
  revoke(input: DeviceOperation): Promise<RegisteredDevice | null>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class RegisteredDevices {
  constructor(private readonly store: DeviceStore) {}
  async execute(action: 'register' | 'find' | 'revoke', input: DeviceOperation) {
    if (!input.identity.emailVerified || !input.identity.providerSubject || !input.identity.sessionReference
      || !uuid.test(input.installationId)) return null;
    return this.store[action]({ ...input, capture: {
      schemaVersion: 1, contractVersion: 'v1', correlationId: input.correlationId,
      inputs: { action, installationId: input.installationId, sessionBound: true },
      sources: [{ source: 'verified-native-session', capturedAt: new Date().toISOString(), quality: 'verified' }],
      consent: { status: 'not_required' }, rule: { id: 'session-bound-installation', version: '1' }, outcome: action,
    } });
  }
}
