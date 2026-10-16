import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalSecurityAlert, publishSecurityAlerts, securityAlertPolicy } from '../backend/identity-consent-ecosystem/src/application/security-alerts';
import type { AlertDelivery, ClaimedSecurityAlert, SecurityAlert, SecurityAlertOutbox } from '../backend/identity-consent-ecosystem/src/application/ports/security-alerts';
import { CloudflareEmailDelivery } from '../backend/identity-consent-ecosystem/src/adapters/outbound/cloudflare-security-alerts';

const eventId = '10000000-0000-4000-8000-000000000001';
const traceId = '20000000-0000-4000-8000-000000000001';
const leaseId = '30000000-0000-4000-8000-000000000001';
const now = Date.parse('2026-10-15T12:00:00Z');
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
function event(changes: Partial<ClaimedSecurityAlert> = {}): ClaimedSecurityAlert {
  return { eventId, eventType: 'identity.security_denied', eventVersion: 1, aggregateType: 'security_decision',
    aggregateId: eventId, correlationId: traceId, createdAt: now - 100, leaseUntil: now + 60_000, attempts: 1,
    payload: { schemaVersion: 1, decisionId: eventId, correlationId: traceId, category: 'api_access',
      channel: 'partner', operation: 'quotes:create', cause: 'forbidden' }, ...changes };
}
function indexedEvent(index: number): ClaimedSecurityAlert {
  const id = `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
  return event({ eventId: id, aggregateId: id, payload: { schemaVersion: 1, decisionId: id,
    correlationId: traceId, category: 'api_access', channel: 'partner', operation: 'quotes:create', cause: 'forbidden' } });
}
function fixture(events: ClaimedSecurityAlert[] = [event()]) {
  const updates: { eventId: string; owner: string; outcome: 'published' | 'failed'; delay?: number | null }[] = [];
  let claimed: Parameters<SecurityAlertOutbox['claim']>[0] | undefined;
  let owned = true;
  const outbox: SecurityAlertOutbox = {
    async claim(input) { claimed = input; return { events, deadLettered: 0 }; },
    async published(id, owner) { updates.push({ eventId: id, owner, outcome: 'published' }); return owned; },
    async failed(id, owner, delay) { updates.push({ eventId: id, owner, outcome: 'failed', delay }); return owned; },
  };
  const delivered: SecurityAlert[] = [];
  const delivery: AlertDelivery = { async deliver(alert) { delivered.push(alert); return { accepted: true }; } };
  return { outbox, delivery, delivered, updates, claim: () => claimed,
    loseLease() { owned = false; }, run: (transport: AlertDelivery = delivery) => publishSecurityAlerts({
      outbox, delivery: transport, now: () => now, newId: () => leaseId,
    }) };
}

test('publication awaits provider acknowledgement and uses the bounded lease policy', async () => {
  const f = fixture();
  let acknowledge: (value: { accepted: true }) => void = () => {};
  const pending = new Promise<{ accepted: true }>(resolve => { acknowledge = resolve; });
  const run = f.run({ deliver: () => pending });
  await Promise.resolve();
  assert.deepEqual(f.updates, []);
  assert.deepEqual(f.claim(), { leaseOwner: leaseId, limit: 10, leaseMs: 60_000, maxAttempts: 5 });
  acknowledge({ accepted: true });
  assert.deepEqual(await run, { claimed: 1, accepted: 1, published: 1, retried: 0, deadLettered: 0, leaseLost: 0 });
  assert.deepEqual(f.updates, [{ eventId, owner: leaseId, outcome: 'published' }]);
});

test('canonical alerts contain only closed codes, UUIDs and a normalized timestamp', () => {
  assert.deepEqual(canonicalSecurityAlert(event()), {
    schemaVersion: 1, eventId, decisionId: eventId, correlationId: traceId, category: 'api_access',
    channel: 'partner', operation: 'quotes:create', cause: 'forbidden', occurredAt: '2026-10-15T11:59:59.900Z',
  });
  const original = event();
  const payload = original.payload as Record<string, unknown>;
  for (const change of [
    { payload: null }, { payload: [] }, { eventType: 'identity.client_created' }, { eventVersion: 2 },
    { eventId: 'person@example.invalid' }, { correlationId: 'Bearer synthetic' }, { aggregateId: traceId },
    { createdAt: NaN }, { createdAt: Number.MAX_VALUE }, { attempts: 0 },
    { payload: { ...payload, cause: 'person@example.invalid' } },
    { payload: { ...payload, operation: 'admin:all' } }, { payload: { ...payload, channel: 'unknown' } },
    { payload: { ...payload, decisionId: traceId } }, { payload: { ...payload, correlationId: eventId } },
    { payload: { ...payload, pii: 'synthetic-secret' } }, { payload: { ...payload, category: 'consent_use' } },
  ]) assert.equal(canonicalSecurityAlert(event(change)), null, JSON.stringify(change));
});

test('invalid security events are quarantined without invoking the transport', async () => {
  const f = fixture([event({ payload: { message: 'synthetic-secret' } })]);
  assert.equal((await f.run()).deadLettered, 1);
  assert.deepEqual(f.delivered, []);
  assert.deepEqual(f.updates, [{ eventId, owner: leaseId, outcome: 'failed', delay: null }]);
});

test('retryable failures keep the stable event ID and stop after five claims', async () => {
  for (let attempt = 1; attempt <= securityAlertPolicy.maxAttempts; attempt++) {
    const f = fixture([event({ attempts: attempt })]);
    const result = await f.run({ async deliver(alert) {
      assert.equal(alert.eventId, eventId);
      if (attempt % 2) throw Error('provider_error_with_synthetic_secret');
      return { accepted: false, retryable: true };
    } });
    assert.equal(result.published, 0);
    assert.equal(result.retried, attempt < 5 ? 1 : 0);
    assert.equal(result.deadLettered, attempt === 5 ? 1 : 0);
    assert.equal(f.updates[0].delay, attempt < 5 ? 1_000 * 2 ** (attempt - 1) : null);
  }
});

test('permanent rejection is dead-lettered and expired ownership never reports publication', async () => {
  const permanent = fixture();
  assert.equal((await permanent.run({ async deliver() { return { accepted: false, retryable: false }; } })).deadLettered, 1);
  const expired = fixture([event({ leaseUntil: now })]);
  assert.equal((await expired.run()).leaseLost, 1);
  assert.deepEqual(expired.delivered, []);
  assert.deepEqual(expired.updates, []);
  const lost = fixture();
  lost.loseLease();
  const result = await lost.run();
  assert.equal(result.accepted, 1);
  assert.equal(result.published, 0);
  assert.equal(result.leaseLost, 1);
});

test('an uncertain SQL publication acknowledgement propagates without resending in the invocation', async () => {
  const f = fixture();
  f.outbox.published = async () => { throw Error('security_alert_outbox_unavailable'); };
  await assert.rejects(f.run(), /security_alert_outbox_unavailable/);
  assert.equal(f.delivered.length, 1);
  assert.deepEqual(f.updates, []);
});

test('a repository exceeding the ten-event bound is rejected before delivery', async () => {
  const f = fixture(Array.from({ length: 11 }, () => event()));
  await assert.rejects(f.run(), /invalid_security_alert_batch/);
  assert.deepEqual(f.delivered, []);
});

test('a ten-event batch never exceeds two simultaneous deliveries and each ACK advances independently', async () => {
  const events = Array.from({ length: 10 }, (_, index) => indexedEvent(index));
  const f = fixture(events);
  const acknowledgements = events.map(() => deferred<{ accepted: true }>());
  const started = events.map(() => deferred<void>());
  const published = events.map(() => deferred<void>());
  const originalPublished = f.outbox.published;
  let active = 0;
  let peak = 0;
  f.outbox.published = async (id, owner) => {
    const value = await originalPublished(id, owner);
    published[events.findIndex(event => event.eventId === id)].resolve();
    return value;
  };
  const run = f.run({ async deliver(alert) {
    const index = events.findIndex(event => event.eventId === alert.eventId);
    active++;
    peak = Math.max(peak, active);
    started[index].resolve();
    try { return await acknowledgements[index].promise; }
    finally { active--; }
  } });
  await Promise.all([started[0].promise, started[1].promise]);
  assert.equal(active, 2);
  assert.deepEqual(f.updates, []);
  acknowledgements[1].resolve({ accepted: true });
  await published[1].promise;
  assert.equal(f.updates.some(update => update.eventId === events[0].eventId), false);
  for (let index = 2; index < events.length; index++) {
    await started[index].promise;
    acknowledgements[index].resolve({ accepted: true });
    await published[index].promise;
  }
  assert.equal(active, 1, 'The first unacknowledged event stays pending while the other lane drains');
  assert.equal(f.updates.length, 9);
  acknowledgements[0].resolve({ accepted: true });
  assert.deepEqual(await run, { claimed: 10, accepted: 10, published: 10, retried: 0, deadLettered: 0, leaseLost: 0 });
  assert.equal(peak, 2);
  assert.equal(active, 0);
});

test('one provider failure retries only its event while the other lane independently publishes', async () => {
  const events = Array.from({ length: 3 }, (_, index) => indexedEvent(index));
  const f = fixture(events);
  const secondAck = deferred<{ accepted: true }>();
  const thirdPublished = deferred<void>();
  const originalPublished = f.outbox.published;
  f.outbox.published = async (id, owner) => {
    const value = await originalPublished(id, owner);
    if (id === events[2].eventId) thirdPublished.resolve();
    return value;
  };
  const run = f.run({ async deliver(alert) {
    if (alert.eventId === events[0].eventId) throw Error('synthetic-provider-failure');
    if (alert.eventId === events[1].eventId) return secondAck.promise;
    return { accepted: true };
  } });
  await thirdPublished.promise;
  assert.deepEqual(f.updates.find(update => update.eventId === events[0].eventId),
    { eventId: events[0].eventId, owner: leaseId, outcome: 'failed', delay: 1_000 });
  assert.equal(f.updates.some(update => update.eventId === events[1].eventId), false);
  secondAck.resolve({ accepted: true });
  assert.deepEqual(await run, { claimed: 3, accepted: 2, published: 2, retried: 1, deadLettered: 0, leaseLost: 0 });
});

test('one SQL acknowledgement failure waits for the other lane and does not cancel its independent commit', async () => {
  const events = [indexedEvent(0), indexedEvent(1)];
  const f = fixture(events);
  const sqlFailure = deferred<void>();
  const secondAck = deferred<{ accepted: true }>();
  const originalPublished = f.outbox.published;
  f.outbox.published = async (id, owner) => {
    if (id === events[0].eventId) { sqlFailure.resolve(); throw Error('security_alert_outbox_unavailable'); }
    return originalPublished(id, owner);
  };
  let finished = false;
  const rejection = assert.rejects(f.run({ async deliver(alert) {
    return alert.eventId === events[0].eventId ? { accepted: true } : secondAck.promise;
  } }), /security_alert_outbox_unavailable/).then(() => { finished = true; });
  await sqlFailure.promise;
  assert.equal(finished, false);
  secondAck.resolve({ accepted: true });
  await rejection;
  assert.deepEqual(f.updates, [{ eventId: events[1].eventId, owner: leaseId, outcome: 'published' }]);
});

test('existing device denials project only allowlisted outcomes without copying their historical capture', async () => {
  for (const outcome of ['binding_revoked', 'installation_replacement', 'registration_window_expired']) {
    const f = fixture([event({ eventType: 'identity.device_registration_denied', aggregateType: 'device_registration',
      aggregateId: leaseId, payload: { decisionId: leaseId, action: 'registration_denied', sessionBound: true,
        capture: { schemaVersion: 1, correlationId: traceId, outcome, inputs: { opaqueButPrivate: 'synthetic-secret' } } } })]);
    assert.equal((await f.run()).published, 1);
    assert.equal(f.delivered[0].cause, outcome);
    assert.equal(f.delivered[0].decisionId, leaseId);
    assert.equal(f.delivered[0].category, 'device_registration');
    assert.equal(JSON.stringify(f.delivered).includes('synthetic-secret'), false);
  }
  const invalid = event({ eventType: 'identity.device_registration_denied', aggregateType: 'device_registration',
    payload: { decisionId: eventId, action: 'registration_denied', sessionBound: true,
      capture: { schemaVersion: 1, correlationId: traceId, outcome: 'person@example.invalid' } } });
  assert.equal(canonicalSecurityAlert(invalid), null);
});

const emailConfig = { from: 'security@example.invalid', to: 'operator@example.invalid', environment: 'staging' as const };
test('Cloudflare email sends a fixed projection and accepts only a valid provider message ID', async () => {
  const calls: unknown[] = [];
  const receipt: { messageId: string } = { messageId: 'synthetic-provider-ack' };
  const adapter = new CloudflareEmailDelivery({ async send(message: unknown) { calls.push(message); return receipt; } }, emailConfig);
  const alert = canonicalSecurityAlert(event());
  assert.ok(alert);
  assert.deepEqual(await adapter.deliver(Object.assign(alert, { header: 'synthetic-secret' })), { accepted: true });
  assert.equal(JSON.stringify(calls).includes('synthetic-secret'), false);
  assert.deepEqual(Object.keys(calls[0] as object).sort(), ['from', 'html', 'subject', 'text', 'to']);
  assert.match(JSON.stringify(calls), new RegExp(eventId));
  for (const id of ['', 'contains\nheader', 'x'.repeat(257)]) {
    receipt.messageId = id;
    assert.deepEqual(await adapter.deliver(alert), { accepted: false, retryable: true });
  }
});

test('email timeout is an unknown acknowledgement and late acceptance cannot mark the outbox published', async () => {
  const f = fixture();
  let expire = () => {};
  let acknowledge: (value: { messageId: string }) => void = () => {};
  let cancelled = false;
  const pending = new Promise<{ messageId: string }>(resolve => { acknowledge = resolve; });
  const adapter = new CloudflareEmailDelivery({ send: () => pending }, emailConfig, (callback, milliseconds) => {
    assert.equal(milliseconds, 3_000); expire = callback; return () => { cancelled = true; };
  });
  const run = f.run(adapter);
  await Promise.resolve();
  expire();
  assert.equal((await run).retried, 1);
  acknowledge({ messageId: 'synthetic-late-ack' });
  await Promise.resolve();
  assert.equal(cancelled, true);
  assert.deepEqual(f.updates, [{ eventId, owner: leaseId, outcome: 'failed', delay: 1_000 }]);
});

test('email ACK lanes can leave ten uncancelled sends pending while retries keep event IDs and publication stays unconfirmed', async () => {
  const events = Array.from({ length: 10 }, (_, index) => indexedEvent(index));
  const f = fixture(events);
  const pending = events.map(() => deferred<{ messageId: string }>());
  const started = events.map(() => deferred<void>());
  const settled = deferred<void>();
  const expirations: (() => void)[] = [];
  const sentIds: string[] = [];
  let active = 0;
  let peak = 0;
  let sendCount = 0;
  const adapter = new CloudflareEmailDelivery({ async send(message) {
    assert.ok('subject' in message);
    const id = String(message.subject).match(/[a-f0-9-]{36}$/)?.[0];
    assert.ok(id);
    sentIds.push(id);
    const index = sendCount++;
    if (index >= events.length) return { messageId: `synthetic-retry-${index}` };
    active++;
    peak = Math.max(peak, active);
    started[index].resolve();
    try { return await pending[index].promise; }
    finally { active--; if (active === 0) settled.resolve(); }
  } }, emailConfig, (expire, milliseconds) => {
    assert.equal(milliseconds, 3_000);
    expirations.push(expire);
    return () => {};
  });
  const run = f.run(adapter);
  for (let wave = 0; wave < 5; wave++) {
    await started[wave * 2 + 1].promise;
    assert.equal(active, (wave + 1) * 2, 'timed-out provider calls have not been cancelled');
    expirations[wave * 2]();
    expirations[wave * 2 + 1]();
  }
  assert.deepEqual(await run, { claimed: 10, accepted: 0, published: 0, retried: 10, deadLettered: 0, leaseLost: 0 });
  assert.equal(peak, 10);
  assert.equal(active, 10);
  assert.deepEqual(sentIds, events.map(value => value.eventId));
  assert.ok(f.updates.every(update => update.outcome === 'failed' && update.delay === 1_000));
  assert.deepEqual(f.updates.map(update => update.eventId).sort(), events.map(value => value.eventId).sort());
  const firstUpdates = f.updates.slice();
  pending.forEach((ack, index) => ack.resolve({ messageId: `synthetic-late-${index}` }));
  await settled.promise;
  assert.equal(active, 0);
  assert.deepEqual(f.updates, firstUpdates, 'late provider acceptance cannot publish the timed-out attempt');

  const retry = fixture(events.map(value => ({ ...value, attempts: 2 })));
  assert.equal((await retry.run(adapter)).published, 10);
  assert.deepEqual(sentIds.slice(10), sentIds.slice(0, 10), 'the new attempt sends the same event IDs');
  assert.deepEqual(f.updates, firstUpdates);
});

test('provider exceptions do not escape or echo credentials and configuration rejects header injection', async () => {
  const adapter = new CloudflareEmailDelivery({ async send() { throw Error('synthetic-secret'); } }, emailConfig);
  const alert = canonicalSecurityAlert(event());
  assert.ok(alert);
  assert.deepEqual(await adapter.deliver(alert), { accepted: false, retryable: true });
  for (const config of [{ ...emailConfig, from: '' }, { ...emailConfig, to: 'operator@example.invalid\r\nBcc: other@example.invalid' }]) {
    assert.throws(() => new CloudflareEmailDelivery({ async send() { return { messageId: 'synthetic' }; } }, config),
      /invalid_security_alert_email_configuration/);
  }
});

test('the email boundary refuses altered canonical values before sending any content', async () => {
  let calls = 0;
  const adapter = new CloudflareEmailDelivery({ async send() { calls++; return { messageId: 'synthetic' }; } }, emailConfig);
  for (const change of [
    { cause: 'synthetic-private-marker' }, { operation: 'person@example.invalid' }, { channel: 'private-channel' },
    { category: 'unrestricted' }, { eventId: 'person@example.invalid' }, { decisionId: 'person@example.invalid' },
    { correlationId: 'person@example.invalid' }, { occurredAt: 'person@example.invalid' }, { schemaVersion: 2 },
    { category: 'consent_use', channel: 'partner' },
  ]) {
    const alert = canonicalSecurityAlert(event());
    assert.ok(alert);
    assert.deepEqual(await adapter.deliver(Object.assign(alert, change)), { accepted: false, retryable: false });
  }
  assert.equal(calls, 0);
});

test('email message and verified configuration are snapshots that caller aliases cannot alter', async () => {
  const calls: { from: unknown; to: unknown; subject: unknown; text: unknown }[] = [];
  const config = { ...emailConfig };
  const adapter = new CloudflareEmailDelivery({ async send(message) {
    assert.ok('subject' in message);
    calls.push({ from: message.from, to: message.to, subject: message.subject, text: message.text });
    return { messageId: 'synthetic-ack' };
  } }, config);
  Object.assign(config, { from: 'changed@example.invalid', to: 'changed-recipient@example.invalid', environment: 'synthetic-private-marker' });
  const alert = canonicalSecurityAlert(event());
  assert.ok(alert);
  const sending = adapter.deliver(alert);
  Object.assign(alert, { cause: 'synthetic-private-marker', eventId: 'person@example.invalid' });
  assert.deepEqual(await sending, { accepted: true });
  assert.equal(calls[0].from, emailConfig.from);
  assert.equal(calls[0].to, emailConfig.to);
  assert.match(String(calls[0].subject), /\[staging\]/);
  assert.equal(JSON.stringify(calls).includes('synthetic-private-marker'), false);
  assert.equal(JSON.stringify(calls).includes('person@example.invalid'), false);
});
