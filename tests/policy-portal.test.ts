import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { issuanceTimeContent, offerContent, paymentContent, policyDocument } from '../backend/policy-claims-payments/src/domain/financial';
import { conditionsFor } from '../backend/policy-claims-payments/src/domain/policy-conditions';
import { documentFile, policyDetail } from '../backend/policy-claims-payments/src/domain/policy-portal';
import type { IssuedPolicyFacts } from '../backend/policy-claims-payments/src/domain/policy-portal';
import type { FinancialStore, Payment, PolicyRecord, StoredPolicy } from '../backend/policy-claims-payments/src/application/ports/financial';
import { PolicyFinance } from '../backend/policy-claims-payments/src/application/policy-finance';
import { renderPdf } from '../backend/policy-claims-payments/src/adapters/inbound/pdf';
import { acceptedOffer, financialIntegrity, financialNow } from './financial-fixtures';

const paidAt = '2026-10-16T02:00:05.000Z';
const issued = financialNow().toISOString();

async function issuedRecord(product: 'vida_hipotecario' | 'flight_delay' | 'weather_event'): Promise<PolicyRecord> {
  const offer = (await acceptedOffer(product)).payload, id = randomUUID(), document = policyDocument(id, offer);
  const policy: StoredPolicy = { id, clientId: offer.clientId, subjectToken: offer.subjectToken, status: 'issued', offer,
    termsHash: await financialIntegrity.digest(offerContent(offer)), document, documentHash: await financialIntegrity.digest(document),
    premium: offer.premium, currency: 'COP', offerId: offer.offerId, offerVersion: offer.offerVersion,
    effectiveFrom: offer.effectiveFrom, effectiveUntil: offer.effectiveUntil, coverageSnapshot: offer.coverage };
  const premium: Payment = { id: randomUUID(), policyId: id, operation: 'premium', key: 'initial-premium', amount: policy.premium, currency: 'COP',
    hash: '', status: 'confirmed', providerReference: null, updatedAt: paidAt };
  premium.providerReference = 'MOCK-' + premium.id;
  premium.hash = await financialIntegrity.digest(paymentContent(premium));
  const signedAt = financialNow().toISOString();
  return { policy, premium, signature: { documentHash: policy.documentHash, signedAt,
    receipt: await financialIntegrity.digest(JSON.stringify(['mock-signature-v1', id, policy.documentHash])),
    timeSeal: await financialIntegrity.digest(issuanceTimeContent(id, policy.documentHash, signedAt)) } };
}

const unexpected = async (): Promise<never> => { throw new Error('unexpected_call'); };
function financeFor(records: PolicyRecord[], rejected: string[] = [], enabled = true) {
  const store: FinancialStore = { readOwnPolicies: unexpected, readAcceptedPolicy: unexpected, importAcceptance: unexpected, issuanceCandidates: unexpected, transaction: unexpected,
    readPolicy: async id => records.find(record => record.policy.id === id) ?? null, rejection: async (_id, _trace, cause) => { rejected.push(cause); } };
  return new PolicyFinance({ enabled, environment: 'local', integrity: financialIntegrity, now: financialNow, newId: randomUUID, store,
    payments: { lookup: unexpected, settle: unexpected, refund: unexpected }, signatures: { sign: unexpected } });
}
const actorOf = ({ policy }: PolicyRecord) => ({ clientId: policy.clientId, subjectToken: policy.subjectToken });

test('the detail of an issued policy gives its coverage, product exclusions, documents with their issue date and the premium payment', async () => {
  const record = await issuedRecord('vida_hipotecario');
  const result = await financeFor([record]).detail({ actor: actorOf(record), policyId: record.policy.id, traceId: randomUUID() });
  assert.ok(result.status === 'ok', JSON.stringify(result));
  assert.deepEqual(result.detail, {
    policyId: record.policy.id, product: 'vida_hipotecario', status: 'issued', premium: '86400.0000', currency: 'COP',
    effectiveFrom: record.policy.effectiveFrom, effectiveUntil: record.policy.effectiveUntil, coverage: { kind: 'mortgage_life', sumInsured: '320000000.0000' },
    exclusions: conditionsFor('vida_hipotecario', issued).exclusions, conditionsVersion: conditionsFor('vida_hipotecario', issued).version,
    documents: [{ documentId: 'signed_policy', issuedAt: financialNow().toISOString() }, { documentId: 'general_conditions', issuedAt: financialNow().toISOString() },
      { documentId: 'premium_receipt', issuedAt: paidAt }],
    payments: [{ date: paidAt, amount: '86400.0000', currency: 'COP', status: 'paid', reference: record.premium?.providerReference }] });
  const serialized = JSON.stringify(result);
  for (const secret of ['documentHash', 'timeSeal', 'termsHash', 'offerId', record.policy.documentHash, record.signature?.receipt as string, record.signature?.timeSeal as string,
    record.policy.subjectToken, record.policy.clientId]) assert.ok(!serialized.includes(secret), secret);
});

test('each product shows its own exclusions and coverage', async () => {
  const mortgage = await issuedRecord('vida_hipotecario'), flight = await issuedRecord('flight_delay');
  const result = await financeFor([flight]).detail({ actor: actorOf(flight), policyId: flight.policy.id, traceId: randomUUID() });
  assert.ok(result.status === 'ok');
  assert.equal(result.detail.coverage.kind, 'flight_delay');
  assert.deepEqual(result.detail.exclusions, conditionsFor('flight_delay', issued).exclusions);
  assert.notDeepEqual(result.detail.exclusions, conditionsFor('vida_hipotecario', issued).exclusions);
  assert.ok(mortgage.policy.id !== flight.policy.id);
});

test('a weather policy shows its own station coverage, exclusions and a document that names that coverage', async () => {
  const weather = await issuedRecord('weather_event');
  const finance = financeFor([weather]);
  const input = { actor: actorOf(weather), policyId: weather.policy.id, traceId: randomUUID() };
  const result = await finance.detail(input);
  assert.ok(result.status === 'ok', JSON.stringify(result));
  assert.equal(result.detail.coverage.kind, 'weather_event');
  assert.deepEqual(result.detail.exclusions, conditionsFor('weather_event', issued).exclusions);
  assert.notDeepEqual(result.detail.exclusions, conditionsFor('flight_delay', issued).exclusions);
  const document = await finance.document({ ...input, documentId: 'general_conditions' });
  assert.ok(document.status === 'ok', JSON.stringify(document));
});

test('a policy still in the purchase flow is waiting: no detail, no document and no financial rejection', async () => {
  const record = await issuedRecord('vida_hipotecario');
  const pending: PolicyRecord = { policy: { ...record.policy, status: 'charged' }, premium: record.premium, signature: null };
  const rejected: string[] = [];
  const finance = financeFor([pending], rejected);
  const input = { actor: actorOf(pending), policyId: pending.policy.id, traceId: randomUUID() };
  const detail = await finance.detail(input);
  assert.ok(detail.status === 'denied' && detail.error === 'policy_pending' && detail.httpStatus === 404);
  const document = await finance.document({ ...input, documentId: 'signed_policy' });
  assert.ok(document.status === 'denied' && document.error === 'policy_pending');
  assert.deepEqual(rejected, []);
});

test('a foreign, tampered or incomplete record is rejected instead of read, and disabled processing fails closed', async () => {
  const record = await issuedRecord('vida_hipotecario');
  const input = { actor: actorOf(record), policyId: record.policy.id, traceId: randomUUID() };
  const rejected: string[] = [];
  const foreign = await financeFor([record], rejected).detail({ ...input, actor: { ...input.actor, subjectToken: randomUUID() } });
  assert.ok(foreign.status === 'denied' && foreign.error === 'not_found' && foreign.httpStatus === 404);
  const tampered = await financeFor([{ ...record, policy: { ...record.policy, premium: '1.0000' } }], rejected).detail(input);
  assert.ok(tampered.status === 'denied' && tampered.error === 'integrity_violation');
  const undated = await financeFor([{ ...record, premium: { ...record.premium as Payment, updatedAt: undefined } }], rejected).detail(input);
  assert.ok(undated.status === 'denied' && undated.error === 'integrity_violation');
  assert.deepEqual(rejected, ['not_found', 'integrity_violation', 'integrity_violation']);
  const invalid = await financeFor([record]).detail({ ...input, policyId: 'not-a-uuid' });
  assert.ok(invalid.status === 'denied' && invalid.httpStatus === 400);
  assert.equal((await financeFor([record], [], false).detail(input)).status, 'unavailable');
});

test('the documents carry the policy facts and the product conditions', async () => {
  const record = await issuedRecord('vida_hipotecario');
  const finance = financeFor([record]);
  const get = async (documentId: 'signed_policy' | 'general_conditions' | 'premium_receipt') => {
    const result = await finance.document({ actor: actorOf(record), policyId: record.policy.id, documentId, traceId: randomUUID() });
    assert.ok(result.status === 'ok', documentId);
    return result.file;
  };
  const policy = await get('signed_policy');
  assert.equal(policy.fileName, `signed-policy-${record.policy.id.slice(0, 8)}.pdf`);
  const policyText = policy.lines.join('\n');
  for (const expected of [record.policy.id, 'Suma asegurada: $ 320.000.000', 'Prima: $ 86.400 (pago único)', record.policy.documentHash, 'Emitida: 2026-10-15 21:00 (hora de Colombia)']) assert.ok(policyText.includes(expected), expected);
  const conditions = (await get('general_conditions')).lines.join('\n');
  assert.ok(conditions.includes(conditionsFor('vida_hipotecario', issued).version));
  for (const item of conditionsFor('vida_hipotecario', issued).exclusions) assert.ok(conditions.includes(item.code + ' ' + item.text));
  const receipt = (await get('premium_receipt')).lines.join('\n');
  for (const expected of [record.premium?.providerReference as string, 'Monto: $ 86.400', 'Estado: pagado']) assert.ok(receipt.includes(expected), expected);
});

test('only a paid premium has a receipt, a declined one is failed and a refunded one is not a portal payment', async () => {
  const record = await issuedRecord('vida_hipotecario');
  const facts = (status: IssuedPolicyFacts['payment']['status']): IssuedPolicyFacts => ({ policyId: record.policy.id, offer: record.policy.offer, premium: record.policy.premium,
    currency: 'COP', effectiveFrom: record.policy.effectiveFrom, effectiveUntil: record.policy.effectiveUntil, documentHash: record.policy.documentHash, signedAt: paidAt,
    payment: { status, reference: 'MOCK-' + randomUUID(), amount: '86400.0000', at: paidAt } });
  for (const [status, expected] of [['pending', 'pending'], ['declined', 'failed']] as const) {
    const detail = policyDetail(facts(status));
    assert.deepEqual(detail.payments.map(payment => [payment.status, payment.reference]), [[expected, null]]);
    assert.ok(!detail.documents.some(document => document.documentId === 'premium_receipt'));
    assert.equal(documentFile('premium_receipt', facts(status)), null);
  }
  assert.throws(() => policyDetail(facts('refunded')));
});

test('the PDF is a deterministic, well-formed file with correct offsets, Latin-1 text, escaped delimiters and page breaks', () => {
  const lines = ['Póliza de vida: señor Peña (confirmado) \\ ¿Vigente?', ...Array.from({ length: 120 }, (_, index) => `Línea ${index} ` + 'texto '.repeat(30))];
  const bytes = renderPdf('Póliza', lines);
  assert.deepEqual(bytes, renderPdf('Póliza', lines));
  const text = Buffer.from(bytes).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4\n') && text.endsWith('%%EOF\n'));
  assert.ok(bytes.includes(0xf3) && bytes.includes(0xf1) && bytes.includes(0xbf), 'accents, ñ and ¿ are single WinAnsi bytes');
  assert.ok(text.includes('\\(confirmado\\) \\\\'), 'delimiters are escaped');
  const pages = Number(/\/Count (\d+)/.exec(text)?.[1]);
  assert.ok(pages > 1);
  assert.equal(text.match(/\/Type \/Page /g)?.length, pages);
  const table = text.slice(text.indexOf('xref\n'), text.indexOf('trailer'));
  const offsets = [...table.matchAll(/^(\d{10}) 00000 n $/gm)].map(match => Number(match[1]));
  assert.ok(offsets.length > 4);
  offsets.forEach((offset, index) => assert.equal(text.slice(offset, offset + `${index + 1} 0 obj`.length), `${index + 1} 0 obj`));
  assert.equal(text.slice(Number(/startxref\n(\d+)/.exec(text)?.[1])).startsWith('xref'), true);
  assert.equal(renderPdf('Vacío', []).length > 0, true);
});

test('a policy keeps the conditions that were in force when it was issued, even after a new version is published', async () => {
  const record = await issuedRecord('vida_hipotecario');
  const first = conditionsFor('vida_hipotecario', issued);
  const changed = { ...first, version: 'academic-conditions-2', exclusions: [{ code: '7.1', text: 'Texto nuevo de prueba.' }] };
  const versions = [{ version: first.version, since: '2026-01-01T00:00:00.000Z', products: { vida_hipotecario: first, flight_delay: first } },
    { version: changed.version, since: '2026-11-01T00:00:00.000Z', products: { vida_hipotecario: changed, flight_delay: changed } }];
  const facts = (signedAt: string): IssuedPolicyFacts => ({ policyId: record.policy.id, offer: record.policy.offer, premium: record.policy.premium, currency: 'COP',
    effectiveFrom: record.policy.effectiveFrom, effectiveUntil: record.policy.effectiveUntil, documentHash: record.policy.documentHash, signedAt,
    payment: { status: 'confirmed', reference: 'MOCK-' + randomUUID(), amount: record.policy.premium, at: signedAt } });
  const before = policyDetail(facts('2026-10-16T02:00:00.000Z'), versions), after = policyDetail(facts('2026-11-02T00:00:00.000Z'), versions);
  assert.equal(before.conditionsVersion, 'academic-conditions-1');
  assert.deepEqual(before.exclusions, first.exclusions);
  assert.equal(after.conditionsVersion, 'academic-conditions-2');
  assert.deepEqual(after.exclusions, changed.exclusions);
  assert.ok(documentFile('general_conditions', facts('2026-10-16T02:00:00.000Z'), versions)?.lines.join('\n').includes(first.exclusions[0].text));
  assert.ok(documentFile('general_conditions', facts('2026-11-02T00:00:00.000Z'), versions)?.lines.join('\n').includes('Texto nuevo de prueba.'));
});
