import type { SecurityDecision } from '../../domain/security-decision';

type DeviceRegistrationAlert = {
  schemaVersion: 1; decisionId: string; correlationId: string; category: 'device_registration';
  channel: 'mobile'; operation: 'mobile:devices';
  cause: 'binding_revoked' | 'installation_replacement' | 'registration_window_expired';
};
export type SecurityAlert = (SecurityDecision | DeviceRegistrationAlert) & { eventId: string; occurredAt: string };
export type ClaimedSecurityAlert = {
  eventId: string;
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string;
  correlationId: string;
  payload: unknown;
  attempts: number;
  createdAt: number;
  leaseUntil: number;
};

export interface SecurityAlertOutbox {
  claim(input: { leaseOwner: string; limit: number; leaseMs: number; maxAttempts: number }):
    Promise<{ events: ClaimedSecurityAlert[]; deadLettered: number }>;
  published(eventId: string, leaseOwner: string): Promise<boolean>;
  failed(eventId: string, leaseOwner: string, retryDelayMs: number | null): Promise<boolean>;
}

export interface AlertDelivery {
  // Implementations must enforce a three-second acknowledgement deadline and confirm provider acceptance.
  // A lost response may cause a duplicate delivery with the same eventId.
  deliver(alert: SecurityAlert): Promise<{ accepted: true } | { accepted: false; retryable: boolean }>;
}
