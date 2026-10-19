import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { settings, clientFor, owners, applyMigrations, applyRuntimeGrants } from './database.mjs';
import { CreateQuote } from '../backend/acquisition-risk/src/application/create-quote';
import { SqlQuoteStore } from '../backend/acquisition-risk/src/adapters/outbound/sql-quote-store';
import { HmacProtector } from '../backend/acquisition-risk/src/adapters/outbound/hmac-protector';
import { SqlOfferStore } from '../backend/acquisition-risk/src/adapters/outbound/sql-offer-store';
import { HmacOfferIntegrity } from '../backend/acquisition-risk/src/adapters/outbound/hmac-offer-integrity';
import { FinancialOutboxPublisher } from '../backend/acquisition-risk/src/adapters/outbound/financial-outbox-publisher';
import { OfferService } from '../backend/acquisition-risk/src/application/offer-service';
import { MockFlightSchedule, MockRiskSignals } from '../backend/acquisition-risk/src/adapters/outbound/mock-risk-signals';
import type { AcceptanceEvent } from '../backend/acquisition-risk/src/application/ports/offer-store';

// Real local owner SQL; Identity and external data sources are explicit stand-ins.
const config = await settings('local');
assert.equal(config.database, 'solventa_local');
const suppliedDatabase = process.env.OFFERS_SQL_DATABASE;
if (suppliedDatabase) assert.match(suppliedDatabase, /^solventa_offers_test_[a-f0-9]{32}$/);
// The publisher drains ready rows. Never run it against another developer's persistent outbox.
const isolatedDatabase = suppliedDatabase ?? 'solventa_offers_test_' + randomUUID().replaceAll('-', '');
assert.match(isolatedDatabase, /^solventa_offers_test_[a-f0-9]{32}$/);
const state = JSON.parse(await readFile('infra/.local/runtime.local.json', 'utf8'));
const url = new URL(config.url); url.pathname = '/' + isolatedDatabase;
const runtime = new URL(url); runtime.username = 'solventa_local_acquisition'; runtime.password = state.passwords.acquisition;
runtime.searchParams.set('sslmode', 'verify-full'); runtime.searchParams.set('sslrootcert', 'infra/.local/certs/ca.crt');
const admin = clientFor(url, config.ssl);
const provisioner = suppliedDatabase ? null : clientFor(config.url, config.ssl);
if (provisioner) {
  let created = false;
  try {
    await provisioner.connect(); await provisioner.query(`CREATE DATABASE ${isolatedDatabase}`); created = true;
    await admin.connect();
    await admin.query(`REVOKE ALL ON DATABASE ${isolatedDatabase} FROM public`); await admin.query('REVOKE ALL ON SCHEMA public FROM public');
    await admin.query('CREATE SCHEMA acquisition'); await admin.query('REVOKE ALL ON SCHEMA acquisition FROM public');
    await admin.query('CREATE TABLE acquisition.schema_migrations (version STRING PRIMARY KEY, checksum STRING NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    await applyMigrations(admin, owners[0]);
    const ledger = (await admin.query('SELECT * FROM acquisition.schema_migrations ORDER BY version')).rows;
    await applyMigrations(admin, owners[0]);
    assert.deepEqual((await admin.query('SELECT * FROM acquisition.schema_migrations ORDER BY version')).rows, ledger, 'unchanged migration replay preserves history');
    await admin.query(`GRANT CONNECT ON DATABASE ${isolatedDatabase} TO solventa_local_acquisition`);
    await admin.query('GRANT USAGE ON SCHEMA acquisition TO solventa_local_acquisition');
    await admin.query('GRANT SELECT ON TABLE acquisition.schema_migrations TO solventa_local_acquisition');
    await applyRuntimeGrants(admin, owners[0], 'solventa_local_acquisition', JSON.parse(await readFile('backend/acquisition-risk/runtime-grants.json', 'utf8')));
  } catch (error) {
    // Failed DDL may survive rollback. Preserve this database and its guard for reconciliation.
    if (created) console.log(JSON.stringify({ preservedGeneratedDatabaseForReconciliation: isolatedDatabase }));
    await admin.end().catch(() => {}); await provisioner.end().catch(() => {}); throw error;
  }
} else await admin.connect();
const actor = { clientId: randomUUID(), subjectToken: randomUUID() };
const other = { clientId: randomUUID(), subjectToken: randomUUID() };
const traces: string[] = [];
const trace = () => { const value = randomUUID(); traces.push(value); return value; };
const now = new Date(), integrity = new HmacOfferIntegrity('local-synthetic-financial-key-'.padEnd(40, 'x'));
const store = new SqlOfferStore(runtime.toString());
const service = new OfferService({ store, provider: new MockRiskSignals(), flights: new MockFlightSchedule(), integrity, clock: { now: () => new Date() }, environment: 'local', enabled: true });
const authorization = { consentId: 'CNS-2026-00001', textVersion: 1, expiresAt: new Date(now.getTime() + 3600000).toISOString() };
let testFailure: unknown;
try {
  const quote = await new CreateQuote({ access: { async authorize() { return { allowed: true, actor: { kind: 'user', ...actor } }; } }, store: new SqlQuoteStore(runtime.toString()), protector: new HmacProtector('local-synthetic-quote-key-'.padEnd(40, 'x')), clock: { now: () => now } }).execute({
    credential: { kind: 'web', cookie: 'synthetic', origin: 'http://localhost:8787', method: 'POST' }, idempotencyKey: randomUUID(), traceId: trace(),
    body: { product: 'vida_hipotecario', customer: { fullName: 'Synthetic Offers SQL', documentType: 'CC', documentNumber: '1099999999', birthDate: '1992-03-14', city: 'Synthetic' }, credit: { partnerCreditId: randomUUID(), amount: 320000000, termMonths: 180 } }
  });
  assert.equal(quote.status, 'created'); if (quote.status !== 'created') throw Error('quote failed');
  const command = { actor, authorization, quoteId: quote.quote.quoteId, idempotencyKey: randomUUID(), traceId: trace() };
  const created = await service.create(command); assert.equal(created.status, 'created'); if (created.status !== 'created') throw Error('offer failed');
  assert.equal((await service.create(command)).status, 'replayed');
  assert.equal((await service.create({ ...command, quoteId: 'COT-2026-99999' })).status, 'conflict');
  assert.equal((await service.get({ actor: other, offerId: created.offer.offerId, traceId: trace() })).status, 'not_found');
  // An authorization that expires while acceptance waits for the offer row lock must not commit an acceptance.
  const lockedOffer = await service.create({ ...command, idempotencyKey: randomUUID(), traceId: trace() });
  assert.equal(lockedOffer.status, 'created');
  if (lockedOffer.status !== 'created') throw Error('locked expiry fixture missing');
  const blocker = clientFor(url, config.ssl); await blocker.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM acquisition.offers WHERE id=$1 FOR UPDATE', [lockedOffer.offer.offerId]);
    const shortAuthorization = { ...authorization, expiresAt: new Date(Date.now() + 700).toISOString() };
    const attempt = service.accept({ actor, authorization: shortAuthorization, offerId: lockedOffer.offer.offerId, idempotencyKey: randomUUID(), traceId: trace() });
    await new Promise(resolve => setTimeout(resolve, 1400));
    await blocker.query('COMMIT');
    assert.equal((await attempt).status, 'expired', 'authorization expiry is checked after acquiring the row lock');
  } finally { await blocker.query('ROLLBACK').catch(() => {}); await blocker.end(); }
  const lockedEffects = await admin.query(`SELECT (SELECT count(*)::INT4 FROM acquisition.offer_acceptances WHERE offer_id=$1) AS acceptances,
    (SELECT count(*)::INT4 FROM acquisition.outbox_events WHERE aggregate_id=$1 AND event_type='offer.accepted') AS outbox,
    (SELECT count(*)::INT4 FROM acquisition.audit_events WHERE resource_id=$1 AND action='offer.accept' AND outcome='success') AS audit`, [lockedOffer.offer.offerId]);
  assert.deepEqual(lockedEffects.rows[0], { acceptances: 0, outbox: 0, audit: 0 });
  const race = { ...command, idempotencyKey: randomUUID(), traceId: trace() };
  const raced = await Promise.all(Array.from({ length: 3 }, () => service.create(race)));
  assert.equal(raced.filter(x => x.status === 'created').length, 1);
  assert.equal(raced.filter(x => x.status === 'replayed').length, 2);
  const c = await admin.query(`SELECT (SELECT count(*)::INT4 FROM acquisition.offer_contexts WHERE offer_id=$1) AS contexts,
    (SELECT count(*)::INT4 FROM acquisition.offer_revisions WHERE offer_id=$1) AS revisions,
    (SELECT count(*)::INT4 FROM acquisition.audit_events WHERE resource_id=$1 AND action='offer.create') AS audit,
    (SELECT count(*)::INT4 FROM acquisition.outbox_events WHERE aggregate_id=$1 AND event_type='offer.created') AS outbox`, [created.offer.offerId]);
  assert.deepEqual(c.rows[0], { contexts: 1, revisions: 1, audit: 1, outbox: 1 });
  // First outcomes include declines. Changed providers cannot overwrite a committed decision.
  const healthyProvider = new MockRiskSignals();
  let deny = true, reads = 0;
  const variableProvider = { async read(subject: string, scope: Parameters<MockRiskSignals['read']>[1], correlation: string) {
    reads++;
    if (deny && scope === 'income_obligations_12m') return { scope, capturedAt: new Date().toISOString(), data: { monthlyIncomeCop: 8000000, monthlyObligationsCop: 5000000 } };
    return healthyProvider.read(subject, scope, correlation);
  } };
  const declining = new OfferService({ store, provider: variableProvider, flights: new MockFlightSchedule(), integrity, clock: { now: () => new Date() }, environment: 'local', enabled: true });
  const declineCommand = { ...command, idempotencyKey: randomUUID(), traceId: trace() };
  assert.equal((await declining.create(declineCommand)).status, 'declined');
  const firstReads = reads; deny = false;
  assert.equal((await declining.create({ ...declineCommand, traceId: trace() })).status, 'declined');
  assert.equal(reads, firstReads, 'decline replay does not re-evaluate changed provider data');
  assert.equal((await declining.create({ ...declineCommand, quoteId: 'COT-2026-99999' })).status, 'conflict');
  assert.equal((await service.createFlight({ actor, flightReference: randomUUID(), idempotencyKey: declineCommand.idempotencyKey, traceId: trace() })).status, 'conflict');
  const declineEffects = (await admin.query(`SELECT r.outcome,
    (SELECT count(*)::INT4 FROM acquisition.underwriting_decisions d WHERE d.id=r.decision_id AND d.outcome='declined') AS decisions,
    (SELECT count(*)::INT4 FROM acquisition.audit_events a WHERE a.resource_id=r.decision_id AND a.action='underwriting.decline') AS audit,
    (SELECT count(*)::INT4 FROM acquisition.outbox_events o WHERE o.aggregate_id=r.decision_id AND o.event_type='underwriting.declined') AS outbox,
    (SELECT count(*)::INT4 FROM acquisition.offer_contexts ctx WHERE ctx.client_id=r.client_id AND ctx.idempotency_key=r.idempotency_key) AS offers
    FROM acquisition.offer_requests r WHERE r.client_id=$1 AND r.idempotency_key=$2`, [actor.clientId, declineCommand.idempotencyKey])).rows[0];
  assert.deepEqual(declineEffects, { outcome: 'declined', decisions: 1, audit: 1, outbox: 1, offers: 0 });
  // Runtime INSERT is allowed, but inconsistent accepted/declined references are rejected by the new table.
  const declineDecision = (await admin.query('SELECT decision_id FROM acquisition.offer_requests WHERE client_id=$1 AND idempotency_key=$2', [actor.clientId, declineCommand.idempotencyKey])).rows[0].decision_id;
  await assert.rejects(admin.query(`INSERT INTO acquisition.offer_requests (client_id,subject_token,idempotency_key,request_identity,outcome,decision_id,offer_id)
    VALUES ($1,$2,$3,$4,'accepted',$5,NULL)`, [actor.clientId, actor.subjectToken, randomUUID(), 'synthetic-invalid-accepted', declineDecision]), /check|constraint/i);
  await assert.rejects(admin.query(`INSERT INTO acquisition.offer_requests (client_id,subject_token,idempotency_key,request_identity,outcome,decision_id,offer_id)
    VALUES ($1,$2,$3,$4,'declined',$5,$6)`, [actor.clientId, actor.subjectToken, randomUUID(), 'synthetic-invalid-declined', declineDecision, created.offer.offerId]), /check|constraint/i);
  deny = true;
  const declineRace = { ...command, idempotencyKey: randomUUID(), traceId: trace() };
  assert.deepEqual((await Promise.all(Array.from({ length: 3 }, () => declining.create(declineRace)))).map(r => r.status), ['declined', 'declined', 'declined']);
  assert.equal((await admin.query('SELECT count(*)::INT4 AS n FROM acquisition.underwriting_decisions WHERE correlation_id=$1', [declineRace.traceId])).rows[0].n, 1);
  // Both provider outcomes race through the same runtime SQL ledger; the loser rolls back all effects.
  const mixed = { ...command, idempotencyKey: randomUUID(), traceId: trace() };
  const mixedResults = await Promise.all([service.create(mixed), declining.create(mixed)]);
  const mixedRows = (await admin.query(`SELECT r.outcome,
    (SELECT count(*)::INT4 FROM acquisition.underwriting_decisions d WHERE d.correlation_id=$3) AS decisions,
    (SELECT count(*)::INT4 FROM acquisition.offer_contexts ctx WHERE ctx.client_id=r.client_id AND ctx.idempotency_key=r.idempotency_key) AS offers,
    (SELECT count(*)::INT4 FROM acquisition.audit_events a WHERE a.correlation_id=$3) AS audit,
    (SELECT count(*)::INT4 FROM acquisition.outbox_events o WHERE o.correlation_id=$3) AS outbox
    FROM acquisition.offer_requests r WHERE r.client_id=$1 AND r.idempotency_key=$2`, [actor.clientId, mixed.idempotencyKey, mixed.traceId])).rows;
  assert.equal(mixedRows.length, 1);
  assert.deepEqual(mixedRows[0], { outcome: mixedRows[0].outcome, decisions: 1, offers: mixedRows[0].outcome === 'accepted' ? 1 : 0, audit: 1, outbox: 1 });
  assert.deepEqual(mixedResults.map(r => r.status).sort(), mixedRows[0].outcome === 'accepted' ? ['created', 'replayed'] : ['declined', 'declined']);
  const acceptance = { actor, authorization, offerId: created.offer.offerId, idempotencyKey: randomUUID(), traceId: trace() };
  const accepted = await Promise.all(Array.from({ length: 3 }, () => service.accept(acceptance)));
  assert.equal(accepted.filter(x => x.status === 'created').length, 1); assert.equal(accepted.filter(x => x.status === 'replayed').length, 2);
  assert.equal((await service.accept({ ...acceptance, idempotencyKey: randomUUID() })).status, 'conflict');
  assert.equal((await service.accept({ ...acceptance, authorization: undefined })).status, 'denied');
  const effects = await admin.query(`SELECT (SELECT count(*)::INT4 FROM acquisition.offer_acceptances WHERE offer_id=$1) AS acceptances,
    (SELECT count(*)::INT4 FROM acquisition.audit_events WHERE resource_id=$1 AND action='offer.accept' AND outcome='success') AS audit,
    (SELECT count(*)::INT4 FROM acquisition.outbox_events WHERE aggregate_id=$1 AND event_type='offer.accepted') AS outbox`, [created.offer.offerId]);
  assert.deepEqual(effects.rows[0], { acceptances: 1, audit: 1, outbox: 1 });
  const flight = await service.createFlight({ actor, flightReference: randomUUID(), idempotencyKey: randomUUID(), traceId: trace() });
  assert.equal(flight.status, 'created'); if (flight.status !== 'created') throw Error('flight failed');
  assert.equal((await service.accept({ actor, offerId: flight.offer.offerId, idempotencyKey: randomUUID(), traceId: trace() })).status, 'created');
  // A context constraint fails after decision, offer and revision inserts; none may survive rollback.
  const storedQuote = await store.quote(actor, quote.quote.quoteId); assert.ok(storedQuote);
  const existing = await store.get(actor, created.offer.offerId); assert.ok(existing);
  const badOfferId = randomUUID(), badTrace = trace();
  await assert.rejects(store.create({ actor, quote: storedQuote, sourceReference: quote.quote.quoteId, requestIdentity: JSON.stringify(['vida_hipotecario', quote.quote.quoteId]), key: randomUUID(),
    offer: { ...existing, terms: { ...existing.terms, offerId: badOfferId }, seal: 'invalid' },
    capture: { synthetic: true }, traceId: badTrace }), /constraint|check/i);
  assert.equal((await admin.query('SELECT count(*)::INT4 AS n FROM acquisition.offers WHERE id=$1', [badOfferId])).rows[0].n, 0);
  assert.equal((await admin.query('SELECT count(*)::INT4 AS n FROM acquisition.underwriting_decisions WHERE correlation_id=$1', [badTrace])).rows[0].n, 0);
  // Required evidence failures must roll back the whole compound write, including the request ledger.
  for (const table of ['audit_events', 'outbox_events']) {
    const withheldOfferId = randomUUID(), withheldTrace = trace(), withheldKey = randomUUID();
    const pendingAcceptance = await service.create({ ...command, idempotencyKey: randomUUID(), traceId: trace() });
    assert.equal(pendingAcceptance.status, 'created');
    if (pendingAcceptance.status !== 'created') throw Error('rollback fixture missing');
    await admin.query(`REVOKE INSERT ON acquisition.${table} FROM solventa_local_acquisition`);
    try {
      await assert.rejects(store.create({ actor, quote: storedQuote, sourceReference: quote.quote.quoteId,
        requestIdentity: JSON.stringify(['vida_hipotecario', quote.quote.quoteId]), key: withheldKey,
        offer: { ...existing, terms: { ...existing.terms, offerId: withheldOfferId } }, capture: { synthetic: true }, traceId: withheldTrace }), /privilege|permission|denied/i);
      await assert.rejects(service.accept({ actor, authorization, offerId: pendingAcceptance.offer.offerId,
        idempotencyKey: randomUUID(), traceId: trace() }), /privilege|permission|denied/i);
    } finally { await admin.query(`GRANT INSERT ON acquisition.${table} TO solventa_local_acquisition`); }
    const rolledBack = (await admin.query(`SELECT
      (SELECT count(*)::INT4 FROM acquisition.offers WHERE id=$1) AS offers,
      (SELECT count(*)::INT4 FROM acquisition.underwriting_decisions WHERE correlation_id=$2) AS decisions,
      (SELECT count(*)::INT4 FROM acquisition.offer_contexts WHERE offer_id=$1) AS contexts,
      (SELECT count(*)::INT4 FROM acquisition.offer_revisions WHERE offer_id=$1) AS revisions,
      (SELECT count(*)::INT4 FROM acquisition.offer_requests WHERE client_id=$3 AND idempotency_key=$4) AS requests,
      (SELECT count(*)::INT4 FROM acquisition.audit_events WHERE correlation_id=$2) AS audit,
      (SELECT count(*)::INT4 FROM acquisition.outbox_events WHERE correlation_id=$2) AS outbox,
      (SELECT count(*)::INT4 FROM acquisition.offer_acceptances WHERE offer_id=$5) AS acceptances,
      (SELECT count(*)::INT4 FROM acquisition.audit_events WHERE resource_id=$5 AND action='offer.accept') AS acceptance_audit,
      (SELECT count(*)::INT4 FROM acquisition.outbox_events WHERE aggregate_id=$5 AND event_type='offer.accepted') AS acceptance_outbox`,
    [withheldOfferId, withheldTrace, actor.clientId, withheldKey, pendingAcceptance.offer.offerId])).rows[0];
    assert.deepEqual(rolledBack, { offers: 0, decisions: 0, contexts: 0, revisions: 0, requests: 0, audit: 0, outbox: 0,
      acceptances: 0, acceptance_audit: 0, acceptance_outbox: 0 });
  }
  // Admin-only tamper fixture proves acceptance fails closed without another financial event.
  await admin.query("UPDATE acquisition.offer_contexts SET terms=jsonb_set(terms,'{premium}','\"1.0000\"'::JSONB) WHERE offer_id=$1", [flight.offer.offerId]);
  assert.equal((await service.accept({ actor, offerId: flight.offer.offerId, idempotencyKey: randomUUID(), traceId: trace() })).status, 'integrity_invalid');
  const readTrace = trace();
  assert.equal((await service.get({ actor, offerId: flight.offer.offerId, traceId: readTrace })).status, 'integrity_invalid');
  assert.equal((await admin.query("SELECT count(*)::INT4 AS n FROM acquisition.audit_events WHERE resource_id=$1 AND action='offer.read' AND outcome='integrity_invalid' AND correlation_id=$2", [flight.offer.offerId, readTrace])).rows[0].n, 1);
  const published: AcceptanceEvent[] = [];
  const publisher = new FinancialOutboxPublisher({ connectionString: runtime.toString(), environment: 'local', integrity, queue: { async send(e) { published.push(e); } } });
  const ready = (await admin.query("SELECT event_id FROM acquisition.outbox_events WHERE event_type='offer.accepted' AND status='pending' ORDER BY created_at")).rows.map(row => row.event_id);
  assert.equal(ready.length, 2);
  // The post-acceptance trigger names its own committed event, so an older ready row cannot delay it.
  const targeted = await publisher.publish(ready[1]); assert.equal(targeted.published, 1); assert.deepEqual(published.map(e => e.eventId), [ready[1]]);
  assert.equal((await admin.query('SELECT status FROM acquisition.outbox_events WHERE event_id=$1', [ready[0]])).rows[0].status, 'pending', 'a targeted run leaves other rows to the scheduled publisher');
  const publication = await publisher.publish(); assert.equal(publication.published, 1); assert.equal(published.length, 2);
  assert.equal((await publisher.publish()).claimed, 0, 'confirmed records are not republished');
  const eventId = published[0].eventId;
  await admin.query("UPDATE acquisition.outbox_events SET status='pending',published_at=NULL,attempts=0,available_at=now()-interval '1 minute' WHERE event_id=$1", [eventId]);
  let acknowledgeLate!: () => void;
  const pendingTransport = new Promise<void>(resolve => { acknowledgeLate = resolve; });
  const attemptedIds: string[] = [];
  const slowPublisher = new FinancialOutboxPublisher({ connectionString: runtime.toString(), environment: 'local', integrity, sendDeadlineMs: 5,
    queue: { send(event) { attemptedIds.push(event.eventId); return pendingTransport; } } });
  assert.equal((await slowPublisher.publish()).deferred, 1);
  acknowledgeLate(); await pendingTransport;
  const late = (await admin.query('SELECT status,published_at FROM acquisition.outbox_events WHERE event_id=$1', [eventId])).rows[0];
  assert.equal(late.status, 'pending'); assert.equal(late.published_at, null, 'late transport acknowledgment cannot mark a timed-out attempt published');
  await admin.query("UPDATE acquisition.outbox_events SET available_at=now()-interval '1 minute' WHERE event_id=$1", [eventId]);
  const recoveredPublisher = new FinancialOutboxPublisher({ connectionString: runtime.toString(), environment: 'local', integrity,
    queue: { async send(event) { attemptedIds.push(event.eventId); } } });
  assert.equal((await recoveredPublisher.publish()).published, 1); assert.deepEqual(attemptedIds, [eventId, eventId], 'recovery preserves the event ID after an uncertain Queue write');
  await admin.query("UPDATE acquisition.outbox_events SET status='pending',published_at=NULL,attempts=0,available_at=now()-interval '1 minute' WHERE event_id=$1", [eventId]);
  const expiredLeasePublisher = new FinancialOutboxPublisher({ connectionString: runtime.toString(), environment: 'local', integrity,
    queue: { async send() { await admin.query("UPDATE acquisition.outbox_events SET lease_until=now()-interval '1 minute' WHERE event_id=$1", [eventId]); } } });
  assert.equal((await expiredLeasePublisher.publish()).published, 0);
  const unconfirmed = (await admin.query('SELECT status,published_at FROM acquisition.outbox_events WHERE event_id=$1', [eventId])).rows[0];
  assert.equal(unconfirmed.status, 'publishing'); assert.equal(unconfirmed.published_at, null, 'an expired lease cannot confirm even with the original owner');
  assert.equal((await recoveredPublisher.publish()).published, 1, 'an expired lease remains recoverable');
  await admin.query("UPDATE acquisition.outbox_events SET status='pending',published_at=NULL,attempts=0,available_at=now()-interval '1 minute' WHERE event_id=$1", [eventId]);
  const failedPublisher = new FinancialOutboxPublisher({ connectionString: runtime.toString(), environment: 'local', integrity, queue: { async send() { throw Error('synthetic queue unavailable'); } } });
  const failure = await failedPublisher.publish(); assert.equal(failure.deferred, 1); assert.equal(failure.published, 0);
  const pending = (await admin.query('SELECT status,published_at FROM acquisition.outbox_events WHERE event_id=$1', [eventId])).rows[0];
  assert.equal(pending.status, 'pending'); assert.equal(pending.published_at, null, 'failure before acknowledgment cannot mark published');
  await admin.query("UPDATE acquisition.outbox_events SET available_at=now()-interval '1 minute' WHERE event_id=$1", [eventId]);
  published.length = 0;
  await Promise.all([publisher.publish(), publisher.publish()]);
  assert.equal(published.length, 1, 'concurrent publisher leases allow one dispatch of a ready row');
  await admin.query(`UPDATE acquisition.outbox_events SET status='pending',published_at=NULL,attempts=0,available_at=now()-interval '1 minute',
    payload=payload || '{"unexpected":"synthetic-rejected-marker"}'::JSONB WHERE event_id=$1`, [eventId]);
  published.length = 0;
  assert.equal((await publisher.publish()).deadLetter, 1); assert.equal(published.length, 0, 'appended unsealed fields cannot be published');
  await admin.query("UPDATE acquisition.outbox_events SET status='publishing',attempts=5,lease_owner='synthetic-expired-lease',lease_until=now()-interval '1 minute' WHERE event_id=$1", [eventId]);
  assert.equal((await publisher.publish()).claimed, 0);
  assert.equal((await admin.query('SELECT status FROM acquisition.outbox_events WHERE event_id=$1', [eventId])).rows[0].status, 'dead_letter', 'interrupted final lease becomes visible');
  try {
    await admin.query('UPDATE acquisition.offer_contexts SET client_id=$2,subject_token=$3 WHERE offer_id=$1', [created.offer.offerId, other.clientId, other.subjectToken]);
    const foreignRead = await service.get({ actor: other, offerId: created.offer.offerId, traceId: trace() });
    assert.equal(foreignRead.status, 'integrity_invalid'); assert.equal('offer' in foreignRead, false);
    assert.equal((await service.accept({ actor: other, authorization, offerId: created.offer.offerId, idempotencyKey: randomUUID(), traceId: trace() })).status, 'integrity_invalid');
    assert.equal((await admin.query('SELECT count(*)::INT4 AS n FROM acquisition.offer_acceptances WHERE offer_id=$1', [created.offer.offerId])).rows[0].n, 1, 'altered lookup owner cannot create another acceptance');
  } finally {
    await admin.query('UPDATE acquisition.offer_contexts SET client_id=$2,subject_token=$3 WHERE offer_id=$1', [created.offer.offerId, actor.clientId, actor.subjectToken]);
  }
  const probe = clientFor(runtime, { ca: (config.ssl as { ca?: string }).ca, rejectUnauthorized: true }); await probe.connect();
  try {
    for (const table of ['offer_contexts', 'offer_acceptances', 'offer_revisions', 'offer_requests']) {
      await assert.rejects(probe.query(`DELETE FROM acquisition.${table}`), /privilege|permission|denied/i);
      await assert.rejects(probe.query(`UPDATE acquisition.${table} SET ${table === 'offer_contexts' ? 'terms_seal=terms_seal' : table === 'offer_acceptances' ? 'result=result' : table === 'offer_requests' ? 'outcome=outcome' : 'premium=premium'}`), /privilege|permission|denied/i);
    }
  } finally { await probe.end(); }
  console.log(JSON.stringify({ status: 'passed', checks: ['quote-owned definitive offer with immutable revision/capture/audit/outbox', 'actor ownership and payload/key conflicts', 'concurrent create and acceptance deduplicate atomically', 'declines replay with one decision/audit/outbox and reject changed request identity', 'request ledger rejects inconsistent outcome and offer references', 'accepted and declined races share one atomic first outcome', 'GET integrity rejection persists its request trace', 'acceptance+audit+signed outbox in one transaction', 'fresh consent required on replay', 'flight source separate from mortgage quote', 'mid-transaction constraint leaves no partial business effect', 'required audit/outbox failure rolls back complete offer graph and acceptance', 'stored term tamper rejected', 'authorization expiring under the offer row lock leaves no acceptance', 'targeted publication of a committed acceptance', 'publisher confirms only after queue acknowledgment', 'publisher failure defers without publication', 'concurrent publisher leases dispatch once', 'unsealed appended fields quarantined', 'interrupted final lease becomes dead letter', 'runtime cannot update/delete offer history'] }));
} catch (error) {
  testFailure = error;
  throw error;
} finally {
  try {
    try {
      const offers = (await admin.query('SELECT offer_id FROM acquisition.offer_contexts WHERE client_id=$1', [actor.clientId])).rows.map(r => r.offer_id);
      const decisions = (await admin.query('SELECT id FROM acquisition.underwriting_decisions WHERE correlation_id=ANY($1::UUID[])', [traces])).rows.map(r => r.id);
      const quotes = (await admin.query('SELECT id FROM acquisition.quotes WHERE client_id=$1', [actor.clientId])).rows.map(r => r.id);
      await admin.query('DELETE FROM acquisition.outbox_events WHERE aggregate_id=ANY($1::UUID[]) OR correlation_id=ANY($2::UUID[])', [[...offers, ...quotes, ...decisions], traces]);
      await admin.query('DELETE FROM acquisition.audit_events WHERE actor_reference=$1 OR correlation_id=ANY($2::UUID[])', [actor.clientId, traces]);
      await admin.query('DELETE FROM acquisition.offer_requests WHERE client_id=$1', [actor.clientId]);
      await admin.query('DELETE FROM acquisition.offer_acceptances WHERE client_id=$1', [actor.clientId]);
      await admin.query('DELETE FROM acquisition.offer_contexts WHERE client_id=$1', [actor.clientId]);
      await admin.query('DELETE FROM acquisition.offer_revisions WHERE offer_id=ANY($1::UUID[])', [offers]);
      await admin.query('DELETE FROM acquisition.offers WHERE id=ANY($1::UUID[])', [offers]);
      await admin.query('DELETE FROM acquisition.underwriting_decisions WHERE id=ANY($1::UUID[])', [decisions]);
      await admin.query('DELETE FROM acquisition.quotes WHERE client_id=$1', [actor.clientId]);
    } finally {
      await admin.end();
      if (provisioner) {
        try { await provisioner.query(`DROP DATABASE ${isolatedDatabase} CASCADE`); }
        finally { await provisioner.end(); }
      }
    }
  } catch (cleanupError) {
    if (!testFailure) throw cleanupError;
    console.error(JSON.stringify({ event: 'offers_sql_cleanup_failed', preservedGeneratedDatabaseForReconciliation: isolatedDatabase }));
  }
}
