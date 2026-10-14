import type { VerifiedIdentity } from './authentication';
import { canonicalInstallationId, decideDeviceOperation, deviceRegistrationWindowMs } from '../domain/registered-device';
import type { DeviceAction, DeviceDecision, DeviceSnapshot, RegisteredDevice } from '../domain/registered-device';

export type { RegisteredDevice } from '../domain/registered-device';
export type DeviceOperation = { identity: VerifiedIdentity; installationId: string; correlationId: string };
export type DeviceCapture = {
  schemaVersion: 1; contractVersion: string; correlationId: string;
  inputs: {
    action: DeviceAction; installationId: string; sessionBound: boolean;
    evaluatedAt: string; registrationWindowMs: number;
    session: DeviceSnapshot['session']; bindings: DeviceSnapshot['bindings'];
  };
  sources: { source: string; capturedAt: string; quality: string }[];
  consent: { status: 'not_required' }; rule: { id: string; version: string }; outcome: string;
};
export type DevicePlan = { decision: DeviceDecision; capture: DeviceCapture };
export interface DeviceStore {
  /** Load an owner-scoped snapshot under lock, evaluate it and commit the plan atomically. */
  execute(input: DeviceOperation, decide: (snapshot: DeviceSnapshot) => DevicePlan): Promise<RegisteredDevice | null>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class RegisteredDevices {
  constructor(private readonly store: DeviceStore) {}
  async execute(action: DeviceAction, input: DeviceOperation) {
    if (!input.identity.emailVerified || !input.identity.providerSubject || !input.identity.sessionReference
      || !uuid.test(input.installationId)) return null;
    const operation = { ...input, installationId: canonicalInstallationId(input.installationId), correlationId: input.correlationId.toLowerCase() };
    return this.store.execute(operation, snapshot => {
      const decision = decideDeviceOperation(action, operation.installationId, snapshot);
      const evaluatedAt = new Date(snapshot.observedAt).toISOString();
      return { decision, capture: {
        schemaVersion: 1, contractVersion: 'v1', correlationId: operation.correlationId,
        inputs: { action, installationId: operation.installationId, sessionBound: true, evaluatedAt,
          registrationWindowMs: deviceRegistrationWindowMs, session: snapshot.session ? { ...snapshot.session } : null,
          bindings: snapshot.bindings.map(binding => ({ ...binding })) },
        sources: [{ source: 'identity-session-device-snapshot', capturedAt: evaluatedAt, quality: 'verified' }],
        consent: { status: 'not_required' }, rule: { id: 'session-bound-installation', version: '1' },
        outcome: decision.effect === 'deny' ? decision.reason : action,
      } };
    });
  }
}
