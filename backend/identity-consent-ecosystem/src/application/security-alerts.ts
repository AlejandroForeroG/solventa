import { canonicalSecurityId, securityCauses, securityChannels, securityDecision, securityOperations } from '../domain/security-decision';
import type { AlertDelivery, ClaimedSecurityAlert, SecurityAlert, SecurityAlertOutbox } from './ports/security-alerts';

export const securityAlertPolicy = { batchSize: 10, concurrency: 2, maxAttempts: 5, leaseMs: 60_000 } as const;
const payloadKeys = ['schemaVersion', 'decisionId', 'correlationId', 'category', 'channel', 'operation', 'cause'];
function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.some(candidate => candidate === value);
}

export function canonicalSecurityAlertProjection(input: unknown): SecurityAlert | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const eventId = canonicalSecurityId(value.eventId);
  const decisionId = canonicalSecurityId(value.decisionId);
  const correlationId = canonicalSecurityId(value.correlationId);
  const { schemaVersion, category, channel, operation, cause, occurredAt } = value;
  if (!eventId || !decisionId || !correlationId || schemaVersion !== 1
    || typeof occurredAt !== 'string' || occurredAt.length !== 24) return null;
  try {
    if (new Date(occurredAt).toISOString() !== occurredAt) return null;
    if (category === 'device_registration') {
      if (channel !== 'mobile' || operation !== 'mobile:devices'
        || !member(cause, ['binding_revoked', 'installation_replacement', 'registration_window_expired'] as const)) return null;
      return { schemaVersion: 1, eventId, decisionId, correlationId, occurredAt,
        category: 'device_registration', channel: 'mobile', operation: 'mobile:devices', cause };
    }
    if (eventId !== decisionId || (category !== 'api_access' && category !== 'consent_use')
      || !member(channel, securityChannels) || !member(operation, securityOperations)
      || !member(cause, securityCauses)) return null;
    const decision = securityDecision({ category, channel, operation, cause }, decisionId, correlationId);
    return { ...decision, eventId, occurredAt };
  } catch { return null; }
}

export function canonicalSecurityAlert(event: ClaimedSecurityAlert): SecurityAlert | null {
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return null;
  const payload = event.payload as Record<string, unknown>;
  const eventId = canonicalSecurityId(event.eventId);
  const correlationId = canonicalSecurityId(event.correlationId);
  if (!eventId || !correlationId || event.eventVersion !== 1 || !Number.isFinite(event.createdAt)
    || !Number.isSafeInteger(event.attempts) || event.attempts < 1 || event.attempts > securityAlertPolicy.maxAttempts) return null;
  if (event.eventType === 'identity.device_registration_denied') {
    const decisionId = canonicalSecurityId(payload.decisionId);
    if (!decisionId || event.aggregateType !== 'device_registration' || canonicalSecurityId(event.aggregateId) !== decisionId
      || payload.action !== 'registration_denied' || payload.sessionBound !== true
      || !payload.capture || typeof payload.capture !== 'object' || Array.isArray(payload.capture)) return null;
    const capture = payload.capture as Record<string, unknown>;
    if (capture.schemaVersion !== 1 || canonicalSecurityId(capture.correlationId) !== correlationId
      || !member(capture.outcome, ['binding_revoked', 'installation_replacement', 'registration_window_expired'] as const)) return null;
    try {
      // Historical device captures contain session and binding snapshots. Only this fixed
      // projection can leave Identity; no capture, actor or installation is copied.
      return { schemaVersion: 1, decisionId, correlationId, category: 'device_registration', channel: 'mobile',
        operation: 'mobile:devices', cause: capture.outcome, eventId, occurredAt: new Date(event.createdAt).toISOString() };
    } catch { return null; }
  }
  if (event.eventType !== 'identity.security_denied' || event.aggregateType !== 'security_decision'
    || canonicalSecurityId(event.aggregateId) !== eventId || canonicalSecurityId(payload.decisionId) !== eventId
    || canonicalSecurityId(payload.correlationId) !== correlationId || payload.schemaVersion !== 1
    || Object.keys(payload).length !== payloadKeys.length || Object.keys(payload).some(key => !payloadKeys.includes(key))
    || (payload.category !== 'api_access' && payload.category !== 'consent_use')
    || !member(payload.channel, securityChannels) || !member(payload.operation, securityOperations)
    || !member(payload.cause, securityCauses)) return null;
  try {
    const decision = securityDecision({ category: payload.category, channel: payload.channel,
      operation: payload.operation, cause: payload.cause }, eventId, correlationId);
    return { ...decision, eventId, occurredAt: new Date(event.createdAt).toISOString() };
  } catch { return null; }
}

export async function publishSecurityAlerts(deps: {
  outbox: SecurityAlertOutbox;
  delivery: AlertDelivery;
  now(): number;
  newId(): string;
}) {
  const candidateLease = canonicalSecurityId(deps.newId());
  if (!candidateLease) throw new Error('invalid_security_alert_lease');
  const leaseOwner = candidateLease;
  const batch = await deps.outbox.claim({ leaseOwner, limit: securityAlertPolicy.batchSize,
    leaseMs: securityAlertPolicy.leaseMs, maxAttempts: securityAlertPolicy.maxAttempts });
  if (batch.events.length > securityAlertPolicy.batchSize) throw new Error('invalid_security_alert_batch');
  const result = { claimed: batch.events.length, accepted: 0, published: 0, retried: 0,
    deadLettered: batch.deadLettered, leaseLost: 0 };
  async function publish(event: ClaimedSecurityAlert) {
    if (!Number.isFinite(event.leaseUntil) || event.leaseUntil <= deps.now()) { result.leaseLost++; return; }
    const alert = canonicalSecurityAlert(event);
    if (!alert) {
      if (await deps.outbox.failed(event.eventId, leaseOwner, null)) result.deadLettered++;
      else result.leaseLost++;
      return;
    }
    let delivery: Awaited<ReturnType<AlertDelivery['deliver']>>;
    try { delivery = await deps.delivery.deliver(alert); }
    catch { delivery = { accepted: false, retryable: true }; }
    if (delivery.accepted) {
      result.accepted++;
      // Never retry the provider here after an uncertain SQL acknowledgement.
      if (await deps.outbox.published(event.eventId, leaseOwner)) result.published++;
      else result.leaseLost++;
    } else {
      const retryDelay = delivery.retryable && event.attempts < securityAlertPolicy.maxAttempts
        ? 1_000 * 2 ** (event.attempts - 1) : null;
      if (await deps.outbox.failed(event.eventId, leaseOwner, retryDelay)) {
        if (retryDelay === null) result.deadLettered++;
        else result.retried++;
      } else result.leaseLost++;
    }
  }
  let next = 0;
  let persistenceFailed = false;
  async function drain() {
    while (next < batch.events.length) {
      const event = batch.events[next++];
      try { await publish(event); }
      catch { persistenceFailed = true; }
    }
  }
  // Await both lanes, including independent acknowledgements, before reporting failure.
  // A failed write leaves its lease recoverable and must not cancel other accepted events.
  await Promise.all(Array.from({ length: Math.min(securityAlertPolicy.concurrency, batch.events.length) }, drain));
  if (persistenceFailed) throw new Error('security_alert_outbox_unavailable');
  return result;
}
