import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { settings, clientFor, owners, applyMigrations, applyRuntimeGrants } from './database.mjs';
import { SqlAdvisorSaleAuthorizations } from '../backend/identity-consent-ecosystem/src/adapters/outbound/sql-advisor-sale-authorizations';
import { authorizeAdvisorSaleAccess } from '../backend/identity-consent-ecosystem/src/application/advisor-sale-access';
import { RISK_SCOPES } from '../backend/identity-consent-ecosystem/src/application/partner-offer-access';
import { AdvisorOffers } from '../backend/acquisition-risk/src/application/advisor-offers';
import { CreateQuote } from '../backend/acquisition-risk/src/application/create-quote';
import { OfferService } from '../backend/acquisition-risk/src/application/offer-service';
import { ReadSignal } from '../backend/acquisition-risk/src/application/read-signal';
import { SqlQuoteStore } from '../backend/acquisition-risk/src/adapters/outbound/sql-quote-store';
import { SqlOfferStore } from '../backend/acquisition-risk/src/adapters/outbound/sql-offer-store';
import { SqlSignalSnapshots } from '../backend/acquisition-risk/src/adapters/outbound/sql-signal-snapshots';
import { HmacProtector } from '../backend/acquisition-risk/src/adapters/outbound/hmac-protector';
import { HmacOfferIntegrity } from '../backend/acquisition-risk/src/adapters/outbound/hmac-offer-integrity';
import { MockFlightSchedule, MockRiskSignals } from '../backend/acquisition-risk/src/adapters/outbound/mock-risk-signals';
import { platformTimer } from '../backend/acquisition-risk/src/adapters/outbound/degradation-log';
import type { AdvisorSaleDecision } from '../backend/acquisition-risk/src/application/ports/advisor-sale-access';
import { PolicyFinance } from '../backend/policy-claims-payments/src/application/policy-finance';
import { SqlFinancialStore } from '../backend/policy-claims-payments/src/adapters/outbound/sql-financial-store';
import { MockSignatureProvider, SqlMockPaymentGateway } from '../backend/policy-claims-payments/src/adapters/outbound/mock-financial-providers';
import { MockParametricEventProvider } from '../backend/policy-claims-payments/src/adapters/outbound/mock-parametric-provider';
import { HmacFinancialIntegrity } from '../backend/policy-claims-payments/src/adapters/outbound/financial-integrity';
import type { SignedOfferAcceptanceV1 } from '../backend/policy-claims-payments/src/domain/financial';

// One disposable database with the three owners' schemas, each reached through its own runtime role. The advisor's and the customer's web sessions,
// the customer's consent check and the external providers are stand-ins; authorization, offers, the signed acceptance, Policy and its ledgers are real.
const config = await settings('local');
assert.equal(config.database, 'solventa_local');
const name = 'solventa_advisor_journey_test_' + randomUUID().replaceAll('-', '');
assert.match(name, /^solventa_advisor_journey_test_[a-f0-9]{32}$/);
const held = JSON.parse(await readFile('infra/.local/runtime.local.json', 'utf8'));
const admin = clientFor(config.url, config.ssl);
let created = false;
let db: ReturnType<typeof clientFor> | undefined;
try {
  await admin.connect();
  const users = (await admin.query('SHOW USERS')).rows;
  for (const role of ['identity', 'acquisition', 'policy']) {
    if (!users.some(user => user.username === `solventa_local_${role}`)) await admin.query(`CREATE USER solventa_local_${role} WITH PASSWORD '${held.passwords[role]}'`);
  }
  await admin.query(`CREATE DATABASE ${name}`); created = true;
  const url = new URL(config.url); url.pathname = '/' + name;
  db = clientFor(url, config.ssl); await db.connect();
  const runtimeFor = (role: 'identity' | 'acquisition' | 'policy') => {
    const runtime = new URL(url); runtime.username = `solventa_local_${role}`; runtime.password = held.passwords[role];
    runtime.searchParams.set('sslmode', 'verify-full'); runtime.searchParams.set('sslrootcert', 'infra/.local/certs/ca.crt');
    return runtime.toString();
  };
  const directories = { identity: 'identity-consent-ecosystem', acquisition: 'acquisition-risk', policy: 'policy-claims-payments' } as const;
  for (const owner of owners) {
    const role = owner.schema as 'identity' | 'acquisition' | 'policy';
    await db.query(`CREATE SCHEMA ${owner.schema}`);
    await db.query(`CREATE TABLE ${owner.schema}.schema_migrations (version STRING PRIMARY KEY, checksum STRING NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await applyMigrations(db, owner);
    await db.query(`GRANT CONNECT ON DATABASE ${name} TO solventa_local_${role}`);
    await db.query(`GRANT USAGE ON SCHEMA ${owner.schema} TO solventa_local_${role}`);
    await db.query(`GRANT SELECT ON TABLE ${owner.schema}.schema_migrations TO solventa_local_${role}`);
    await applyRuntimeGrants(db, owner, `solventa_local_${role}`, JSON.parse(await readFile(`backend/${directories[role]}/runtime-grants.json`, 'utf8')));
  }
  const scalar = async (sql: string, values: unknown[] = []) => Number((await db!.query(sql, values)).rows[0].n);
  const insertClient = async () => {
    const id = (await db!.query('INSERT INTO identity.clients (subject_token) VALUES ($1) RETURNING id', [randomUUID()])).rows[0].id as string;
    return { clientId: id, subjectToken: (await db!.query('SELECT subject_token FROM identity.clients WHERE id=$1', [id])).rows[0].subject_token as string };
  };
  const advisorGrant = async (principal: { clientId: string }) =>
    (await db!.query('INSERT INTO identity.policy_advisor_grants (client_id, expires_at, granted_by) VALUES ($1, now() + interval \'30 days\', $2) RETURNING id', [principal.clientId, randomUUID()])).rows[0].id as string;

  const customer = await insertClient();
  const advisor = await insertClient(), otherAdvisor = await insertClient();
  const advisorReference = await advisorGrant(advisor), otherReference = await advisorGrant(otherAdvisor);
  const now = () => new Date();
  const hours = (count: number) => new Date(Date.now() + count * 3600000);
  const authorizations = new SqlAdvisorSaleAuthorizations(runtimeFor('identity'));

  const consent = { allowed: true as const, consent: { consentId: 'CNS-2026-00001', textVersion: 1, expiresAt: hours(24).toISOString() } };
  let consentGranted = true;
  const principals = new Map([[advisorReference, advisor], [otherReference, otherAdvisor]]);
  const sessions = new Map([['advisor-session', advisorReference], ['other-advisor-session', otherReference]]);
  const access = { authorize: async ({ session, authorizationId, traceId }: { session: { cookie: string; origin: string; requestOrigin: string; method: string }; authorizationId: string; traceId: string }) => {
    const reference = sessions.get(session.cookie);
    return authorizeAdvisorSaleAccess({
      authorize: async () => reference ? { allowed: true, actor: { kind: 'user', channel: 'web', principal: principals.get(reference)!, operations: ['policies:manage-delegated'],
        advisorPermission: { reference, expiresAt: new Date(Date.now() + 4000).toISOString() } } } as never : { allowed: false, error: 'unauthorized', status: 401 },
      advisors: { eligible: async () => null }, authorizations,
      verifyConsents: async () => RISK_SCOPES.map(() => consentGranted ? consent : { allowed: false as const, reason: 'consent_revoked' as const }) as never,
    }, { kind: 'web', ...session, authorizationId, traceId }) as Promise<AdvisorSaleDecision>;
  } };

  const acquisition = runtimeFor('acquisition');
  const financialKey = 'local-synthetic-financial-key-'.padEnd(48, 'x');
  const protector = new HmacProtector('local-synthetic-quote-key-'.padEnd(48, 'x'));
  const quotes = new CreateQuote({ access: { async authorize() { throw Error('advisors never use the quote access port'); } }, store: new SqlQuoteStore(acquisition), protector, clock: { now } });
  const offerStore = new SqlOfferStore(acquisition);
  const offers = new OfferService({ store: offerStore, flights: new MockFlightSchedule(), integrity: new HmacOfferIntegrity(financialKey), clock: { now }, environment: 'local', enabled: true,
    signals: new ReadSignal({ guard: { verify: async () => ({ allowed: false, reason: 'unavailable' }) }, provider: new MockRiskSignals(), snapshots: new SqlSignalSnapshots(acquisition),
      clock: { now }, timer: platformTimer, trace: { record: () => {} } }) });
  const advisorOffers = new AdvisorOffers({ access, quotes, offers, protector });

  const finance = new PolicyFinance({ enabled: true, environment: 'local', integrity: new HmacFinancialIntegrity(financialKey), store: new SqlFinancialStore(runtimeFor('policy')),
    payments: new SqlMockPaymentGateway(runtimeFor('policy')), signatures: new MockSignatureProvider(new HmacFinancialIntegrity(financialKey)),
    parametric: new MockParametricEventProvider(new HmacFinancialIntegrity(financialKey), 'local'), now, newId: randomUUID });

  const session = (cookie: string) => ({ cookie, origin: 'http://localhost:8787', requestOrigin: 'http://localhost:8787', method: 'POST' });
  const quoteBody = { product: 'vida_hipotecario', customer: { fullName: 'Synthetic Assisted Sale', documentType: 'CC', documentNumber: '1099999998', birthDate: '1992-03-14', city: 'Synthetic' },
    credit: { partnerCreditId: randomUUID(), amount: 320000000, termMonths: 180 } };
  const prepare = (cookie: string, authorizationId: string, key: string, body: Record<string, unknown> = quoteBody) =>
    advisorOffers.create({ session: session(cookie), body: { authorizationId, ...body }, idempotencyKey: key, traceId: randomUUID() });

  const grant = async (reference: string, who = customer) => {
    const row = await authorizations.grant({ principal: who, advisorReference: reference, grantedAt: now(), expiresAt: hours(24), traceId: randomUUID() });
    assert.ok(row && row !== 'limit_reached'); return row;
  };

  // 1. The customer authorizes the advisor and the advisor prepares the offer; the offer belongs to the customer.
  const authorization = await grant(advisorReference);
  const prepared = await prepare('advisor-session', authorization.id, 'sale-1');
  assert.equal(prepared.status, 'created'); if (prepared.status !== 'created') throw Error('offer not prepared');
  assert.equal(prepared.offer.status, 'definitive');
  const offerId = prepared.offer.offerId;
  assert.equal((await offers.get({ actor: customer, offerId, traceId: randomUUID() })).status, 'found', 'the offer belongs to the customer');
  assert.equal((await offers.get({ actor: advisor, offerId, traceId: randomUUID() })).status, 'not_found', 'the advisor cannot even read it');
  const retained = (await db.query('SELECT d.input_snapshot->\'channel\' AS channel FROM acquisition.underwriting_decisions d JOIN acquisition.offers o ON o.decision_id=d.id WHERE o.id=$1', [offerId])).rows[0].channel;
  assert.deepEqual(retained, { kind: 'advisor', advisorReference, authorizationId: authorization.id });

  // 2. A retry replays the same offer: no second quote, offer, decision or audit.
  const before = { quotes: await scalar('SELECT count(*)::INT4 AS n FROM acquisition.quotes'), offers: await scalar('SELECT count(*)::INT4 AS n FROM acquisition.offers'),
    decisions: await scalar('SELECT count(*)::INT4 AS n FROM acquisition.underwriting_decisions') };
  const replay = await prepare('advisor-session', authorization.id, 'sale-1');
  assert.deepEqual([replay.status, replay.status === 'replayed' && replay.offer.offerId], ['replayed', offerId]);
  assert.deepEqual({ quotes: await scalar('SELECT count(*)::INT4 AS n FROM acquisition.quotes'), offers: await scalar('SELECT count(*)::INT4 AS n FROM acquisition.offers'),
    decisions: await scalar('SELECT count(*)::INT4 AS n FROM acquisition.underwriting_decisions') }, before);
  assert.equal((await prepare('advisor-session', authorization.id, 'sale-1', { ...quoteBody, credit: { ...quoteBody.credit, amount: 100000000 } })).status, 'idempotency_conflict');

  // 3. A foreign advisor, an invented authorization and a missing session never reach a price and write nothing.
  for (const [cookie, id] of [['other-advisor-session', authorization.id], ['advisor-session', randomUUID()], ['nobody', authorization.id]] as const) {
    const denied = await prepare(cookie, id, 'sale-denied');
    assert.equal(denied.status, 'denied', cookie);
  }
  assert.equal(await scalar('SELECT count(*)::INT4 AS n FROM acquisition.offers'), before.offers);

  // 4. The advisor cannot accept: the offer is not found for them. The customer accepts in their own session.
  const advisorPrincipal = advisor;
  const asAdvisor = await offers.accept({ actor: advisorPrincipal, authorization: consent.consent, offerId, idempotencyKey: randomUUID(), traceId: randomUUID() });
  assert.equal(asAdvisor.status, 'not_found');
  assert.equal(await scalar('SELECT count(*)::INT4 AS n FROM acquisition.offer_acceptances WHERE offer_id=$1', [offerId]), 0);
  const acceptKey = randomUUID();
  const accepted = await offers.accept({ actor: customer, authorization: consent.consent, offerId, idempotencyKey: acceptKey, traceId: randomUUID() });
  assert.equal(accepted.status, 'created'); if (accepted.status !== 'created') throw Error('offer not accepted');
  assert.equal((await offers.accept({ actor: customer, authorization: consent.consent, offerId, idempotencyKey: acceptKey, traceId: randomUUID() })).status, 'replayed');
  assert.equal(await scalar("SELECT count(*)::INT4 AS n FROM acquisition.outbox_events WHERE aggregate_id=$1 AND event_type='offer.accepted'", [offerId]), 1);

  // 5. The signed acceptance becomes the customer's policy in Policy; charge, signature and issuance run with the agreed mocks.
  const event = accepted.committedEvent as unknown as SignedOfferAcceptanceV1;
  const imported = await finance.acceptOffer(event, randomUUID());
  assert.equal(imported.status, 'ok', JSON.stringify(imported)); if (imported.status !== 'ok') throw Error('policy not imported');
  const policy = imported.policy;
  const actor = { clientId: event.payload.clientId, subjectToken: event.payload.subjectToken };
  assert.deepEqual(actor, customer, 'the policy belongs to the customer who accepted, not to the advisor');
  const charged = await finance.charge({ actor, policyId: policy.policyId, documentHash: policy.documentHash, idempotencyKey: randomUUID(), traceId: randomUUID() });
  assert.equal(charged.status, 'ok', JSON.stringify(charged));
  const challenge = await finance.beginSignatureChallenge({ actor, policyId: policy.policyId, documentHash: policy.documentHash, accepted: true, traceId: randomUUID() });
  assert.ok(challenge.status === 'ok' && challenge.challenge);
  if (challenge.status !== 'ok' || !challenge.challenge) throw Error('no signature challenge');
  const issueKey = randomUUID();
  const issued = await finance.issue({ actor, policyId: policy.policyId, documentHash: policy.documentHash, idempotencyKey: issueKey, challengeId: challenge.challenge.challengeId, code: challenge.challenge.demoCode, traceId: randomUUID() });
  assert.equal(issued.status, 'ok', JSON.stringify(issued)); if (issued.status !== 'ok') throw Error('policy not issued');
  assert.equal(issued.policy.status, 'issued');
  const reissued = await finance.issue({ actor, policyId: policy.policyId, documentHash: policy.documentHash, idempotencyKey: issueKey, challengeId: challenge.challenge.challengeId, code: challenge.challenge.demoCode, traceId: randomUUID() });
  assert.equal(reissued.status, 'ok');
  assert.deepEqual([await scalar('SELECT count(*)::INT4 AS n FROM policy.policies'), await scalar("SELECT count(*)::INT4 AS n FROM policy.payments WHERE operation='premium'") ], [1, 1], 'retries create no second policy or charge');

  // 6. Traceability: the policy reaches the advisor and the authorization through its offer, and its client through its subject.
  const policyRow = (await db.query('SELECT offer_id, subject_token FROM policy.policies WHERE id=$1', [policy.policyId])).rows[0];
  assert.equal(policyRow.offer_id, offerId);
  assert.equal(policyRow.subject_token, customer.subjectToken);
  const trace = (await db.query('SELECT d.input_snapshot->\'channel\' AS channel FROM acquisition.underwriting_decisions d JOIN acquisition.offers o ON o.decision_id=d.id WHERE o.id=$1', [policyRow.offer_id])).rows[0].channel;
  assert.deepEqual(trace, { kind: 'advisor', advisorReference, authorizationId: authorization.id });

  // 7. Revocation and the customer's consent each stop the next preparation, including a retry of an earlier sale.
  const revocable = await grant(advisorReference);
  assert.equal((await prepare('advisor-session', revocable.id, 'sale-2', { ...quoteBody, credit: { ...quoteBody.credit, partnerCreditId: randomUUID() } })).status, 'created');
  assert.equal((await authorizations.revoke(customer, revocable.id, now(), randomUUID())).kind, 'revoked');
  const offersBefore = await scalar('SELECT count(*)::INT4 AS n FROM acquisition.offers');
  assert.equal((await prepare('advisor-session', revocable.id, 'sale-3')).status, 'denied');
  assert.equal((await prepare('advisor-session', revocable.id, 'sale-2')).status, 'denied', 'a revoked authorization blocks replays too');
  consentGranted = false;
  const afterConsent = await prepare('advisor-session', authorization.id, 'sale-4');
  assert.deepEqual(afterConsent.status === 'denied' && afterConsent.error, 'consent_required');
  consentGranted = true;
  assert.equal(await scalar('SELECT count(*)::INT4 AS n FROM acquisition.offers'), offersBefore, 'blocked requests wrote nothing');
  console.log(JSON.stringify({ advisorSaleJourneySQL: 'passed', checks: ['authorization', 'offer_for_customer', 'advisor_channel_retained', 'replay_without_duplicates', 'foreign_denied', 'advisor_cannot_accept',
    'customer_accepts', 'policy_import', 'charge_signature_issuance', 'policy_to_advisor_traceability', 'revocation', 'consent_withdrawn'] }));
} finally {
  await db?.end().catch(() => {});
  if (created) await admin.query(`DROP DATABASE ${name} CASCADE`).catch(() => {});
  await admin.end();
}
