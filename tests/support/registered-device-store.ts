import type { DeviceOperation, DevicePlan, DeviceStore, RegisteredDevice } from '../../backend/identity-consent-ecosystem/src/application/registered-devices';
import type { DeviceSnapshot } from '../../backend/identity-consent-ecosystem/src/domain/registered-device';

export class InMemoryDeviceStore implements DeviceStore {
  readonly plans: DevicePlan[] = [];
  calls = 0;
  failRecord = false;
  constructor(readonly snapshot: DeviceSnapshot) {}
  async execute(input: DeviceOperation, decide: (snapshot: DeviceSnapshot) => DevicePlan): Promise<RegisteredDevice | null> {
    this.calls++;
    const plan = decide(structuredClone(this.snapshot));
    const decision = plan.decision;
    if (this.failRecord && (decision.effect === 'register' || decision.effect === 'revoke' || (decision.effect === 'deny' && decision.record))) {
      throw new Error('record_unavailable');
    }
    this.plans.push(plan);
    if (decision.effect === 'deny') return null;
    if (decision.effect === 'register') {
      const binding = { id: '00000000-0000-4000-8000-000000000004', installationId: input.installationId, revoked: false };
      this.snapshot.bindings.push(binding);
      return { id: binding.id, installationId: binding.installationId, status: 'active' };
    }
    if (decision.effect === 'revoke') {
      const binding = this.snapshot.bindings.find(value => value.id === decision.device.id);
      if (binding) binding.revoked = true;
      if (this.snapshot.session) this.snapshot.session.revoked = true;
    }
    return decision.device;
  }
}
