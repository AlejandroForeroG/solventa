import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { canonicalReport, claimNumber, DESCRIPTION_LENGTH, MAX_EVIDENCE_BYTES, MAX_EVIDENCE_FILES, parseReport, type ReportInput } from '../backend/policy-claims-payments/src/domain/claim-report';
import { ClaimReport } from '../backend/policy-claims-payments/src/application/claim-report';
import { R2ClaimEvidence } from '../backend/policy-claims-payments/src/adapters/outbound/r2-claim-evidence';
import type { ClaimEvidenceStore, ClaimReportStore, DraftView, ReportOwner, StoredEvidence } from '../backend/policy-claims-payments/src/application/ports/claim-report';
import { createHttp } from '../backend/policy-claims-payments/src/adapters/inbound/http';
import worker from '../apps/web/worker/index';

const examples = JSON.parse(readFileSync('packages/contracts/examples/claims.json', 'utf8')).report;
const now = new Date('2026-09-09T19:00:00.000Z');
const ids = { clientA: '90000000-0000-4000-8000-0000000000a1', subjectA: '90000000-0000-4000-8000-0000000000a2', clientB: '90000000-0000-4000-8000-0000000000b1',
  subjectB: '90000000-0000-4000-8000-0000000000b2', policy: '90000000-0000-4000-8000-000000000020', otherPolicy: '90000000-0000-4000-8000-000000000021',
  file1: '90000000-0000-4000-8000-0000000000e1', file2: '90000000-0000-4000-8000-0000000000e2', trace: '90000000-0000-4000-8000-0000000000f0' };
const ownerA: ReportOwner = { clientId: ids.clientA, subjectToken: ids.subjectA };
const ownerB: ReportOwner = { clientId: ids.clientB, subjectToken: ids.subjectB };
const description = 'Colisión por alcance en la Autopista Norte con Calle 116, sentido sur. El otro vehículo frenó de golpe.';
const photo = new Uint8Array(2048).fill(7);
const video = new Uint8Array(4096).fill(9);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const report = (change: Record<string, unknown> = {}) => ({ policyId: ids.policy, eventType: 'collision', occurredAt: '2026-09-09T18:55:00.000Z', place: 'Autopista Norte con Calle 116',
  description, evidence: [{ fileId: ids.file1, contentType: 'image/jpeg', byteSize: photo.length, sha256: sha(photo) },
    { fileId: ids.file2, contentType: 'video/mp4', byteSize: video.length, sha256: sha(video) }], ...change });

// A faithful in-memory copy of the store's contract: the claim is always resolved through the owner's policy.
function memoryStore() {
  type Row = { id: string; owner: string; policyId: string; key: string; hash: string; state: string; number: string | null; submittedAt: string | null; files: Map<string, StoredEvidence> };
  const window = { from: Date.parse('2026-01-01T00:00:00.000Z'), until: Date.parse('2027-01-01T00:00:00.000Z') };
  const policies = new Map([[ids.policy, { subject: ids.subjectA, issued: true, ...window }], [ids.otherPolicy, { subject: ids.subjectA, issued: false, ...window }]]);
  const claims = new Map<string, Row>(); let sequence = 0;
  const owned = (owner: ReportOwner, id: string) => { const row = claims.get(id); return row && policies.get(row.policyId)?.subject === owner.subjectToken ? row : undefined; };
  const view = (row: Row): DraftView => ({ claimId: row.id, state: row.state, evidence: [...row.files].map(([fileId, file]) => ({ fileId, state: file.state === 'verified' ? 'verified' as const : 'pending' as const })) });
  const store: ClaimReportStore = {
    async createDraft({ owner, report: input, idempotencyKey, requestHash }) {
      const policy = policies.get(input.policyId);
      if (!policy || policy.subject !== owner.subjectToken || !policy.issued) return { status: 'policy_not_found' };
      const existing = [...claims.values()].find(row => row.policyId === input.policyId && row.key === idempotencyKey);
      if (existing) return existing.hash === requestHash ? { status: 'replayed', claim: view(existing) } : { status: 'idempotency_conflict' };
      const occurred = Date.parse(input.occurredAt);
      if (occurred < policy.from || occurred > policy.until) return { status: 'outside_coverage' };
      const row: Row = { id: `91000000-0000-4000-8000-${String(claims.size + 1).padStart(12, '0')}`, owner: owner.clientId, policyId: input.policyId, key: idempotencyKey, hash: requestHash,
        state: 'draft', number: null, submittedAt: null, files: new Map(input.evidence.map(item => [item.fileId, { claimState: 'draft', contentType: item.contentType, byteSize: item.byteSize, sha256: item.sha256, state: 'pending' as const }])) };
      claims.set(row.id, row);
      return { status: 'created', claim: view(row) };
    },
    async evidence(owner, claimId, fileId) { const row = owned(owner, claimId); const file = row?.files.get(fileId); return row && file ? { ...file, claimState: row.state } : null; },
    async markVerified(owner, claimId, fileId) { const file = owned(owner, claimId)?.files.get(fileId); if (!file) return false; file.state = 'verified'; return true; },
    async submit(owner, claimId) {
      const row = owned(owner, claimId); if (!row) return { status: 'not_found' };
      if (row.state !== 'draft') return row.number && row.submittedAt ? { status: 'already_submitted', claimId, claimNumber: row.number, submittedAt: row.submittedAt } : { status: 'not_found' };
      const missing = [...row.files].filter(([, file]) => file.state !== 'verified').map(([fileId]) => fileId).sort();
      if (missing.length) return { status: 'incomplete', missing };
      row.state = 'unassigned'; row.number = claimNumber(2026, ++sequence); row.submittedAt = now.toISOString();
      return { status: 'submitted', claimId, claimNumber: row.number, submittedAt: row.submittedAt };
    },
  };
  return { store, claims };
}

// The object store verifies the declared checksum while it receives the stream, as R2 does.
type Stream = ReadableStream<Uint8Array>;
function memoryEvidence() {
  const objects = new Map<string, Uint8Array>();
  const evidence: ClaimEvidenceStore<Stream> = {
    async put(key, body, meta) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      if (sha(bytes) !== meta.sha256) return 'checksum_mismatch';
      objects.set(key, bytes);
      return bytes.length === meta.byteSize ? 'stored' : 'size_mismatch';
    },
  };
  return { evidence, objects };
}

// null models an environment whose evidence bucket is not provisioned.
const service = (evidenceStore: ClaimEvidenceStore<Stream> | null = memoryEvidence().evidence) => {
  const memory = memoryStore();
  return { ...memory, application: new ClaimReport<Stream>(memory.store, evidenceStore ?? undefined, { sha256Hex: async text => sha(new TextEncoder().encode(text)) }, { now: () => now }) };
};

test('a valid report is normalized and every invalid field is named without echoing its value', () => {
  const parsed = parseReport(report({ policyId: ids.policy.toUpperCase(), description: `  ${description}  `, place: '  Calle 116  ',
    evidence: [{ fileId: ids.file1.toUpperCase(), contentType: 'image/jpeg', byteSize: 10, sha256: sha(photo).toUpperCase() }] }), now);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual([parsed.value.policyId, parsed.value.description, parsed.value.place, parsed.value.evidence[0].fileId, parsed.value.evidence[0].sha256],
    [ids.policy, description, 'Calle 116', ids.file1, sha(photo)]);
  const long = 'x'.repeat(DESCRIPTION_LENGTH.max + 1);
  const cases: [Record<string, unknown>, string][] = [
    [{ policyId: 'nope' }, 'policyId'], [{ eventType: 'fire' }, 'eventType'], [{ occurredAt: '2026-09-09' }, 'occurredAt'], [{ occurredAt: '2026-09-09T19:30:00.000Z' }, 'occurredAt'],
    [{ occurredAt: '2026-02-30T10:00:00.000Z' }, 'occurredAt'], [{ place: '   ' }, 'place'], [{ place: 'x'.repeat(121) }, 'place'], [{ description: 'too short' }, 'description'],
    [{ description: long }, 'description'], [{ description: description + '\u0000' }, 'description'], [{ evidence: [] }, 'evidence'], [{ evidence: 'file' }, 'evidence'],
    [{ evidence: Array.from({ length: MAX_EVIDENCE_FILES + 1 }, (_, i) => ({ fileId: `90000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, contentType: 'image/png', byteSize: 1, sha256: sha(photo) })) }, 'evidence'],
    [{ evidence: [{ fileId: ids.file1, contentType: 'application/pdf', byteSize: 1, sha256: sha(photo) }] }, 'evidence'],
    [{ evidence: [{ fileId: ids.file1, contentType: 'image/png', byteSize: 0, sha256: sha(photo) }] }, 'evidence'],
    [{ evidence: [{ fileId: ids.file1, contentType: 'image/png', byteSize: 1.5, sha256: sha(photo) }] }, 'evidence'],
    [{ evidence: [{ fileId: ids.file1, contentType: 'image/png', byteSize: 1, sha256: 'abc' }] }, 'evidence'],
    [{ evidence: [{ fileId: ids.file1, contentType: 'image/png', byteSize: 1, sha256: sha(photo), name: 'x.png' }] }, 'evidence'],
    [{ evidence: [{ fileId: ids.file1, contentType: 'image/png', byteSize: 1, sha256: sha(photo) }, { fileId: ids.file1, contentType: 'image/png', byteSize: 1, sha256: sha(photo) }] }, 'evidence'],
    [{ evidence: [{ fileId: ids.file1, contentType: 'video/mp4', byteSize: MAX_EVIDENCE_BYTES, sha256: sha(photo) }, { fileId: ids.file2, contentType: 'video/mp4', byteSize: 1, sha256: sha(video) }] }, 'evidence'],
    [{ unexpected: true }, 'body'],
  ];
  for (const [change, field] of cases) {
    const result = parseReport(report(change), now);
    assert.equal(result.ok, false, JSON.stringify(change).slice(0, 80));
    if (!result.ok) { assert.ok(result.fields.includes(field), `${field}: ${result.fields}`); assert.equal(JSON.stringify(result).includes('Colisión'), false); }
  }
  assert.deepEqual(parseReport(null, now), { ok: false, fields: ['body'] });
  assert.equal(parseReport(report({ place: undefined }), now).ok, true);
  assert.equal(parseReport(report({ evidence: [{ fileId: ids.file1, contentType: 'video/mp4', byteSize: MAX_EVIDENCE_BYTES, sha256: sha(photo) }] }), now).ok, true);
});

test('a location is accepted only with an explicit authorization, is rounded to six decimals and never echoed in an error', () => {
  const ok = parseReport(report({ location: { authorized: true, latitude: 4.6969441234, longitude: -74.0441669 } }), now);
  assert.ok(ok.ok);
  assert.deepEqual((ok as { value: ReportInput }).value.location, { latitude: 4.696944, longitude: -74.044167 });
  assert.equal((parseReport(report(), now) as { value: ReportInput }).value.location, null, 'a report without a location has none');
  for (const location of [{ latitude: 4.69, longitude: -74.04 }, { authorized: false, latitude: 4.69, longitude: -74.04 }, { authorized: 'true', latitude: 4.69, longitude: -74.04 },
    { authorized: true, latitude: 91, longitude: -74.04 }, { authorized: true, latitude: 4.69, longitude: -181 }, { authorized: true, latitude: '4.69', longitude: -74.04 },
    { authorized: true, latitude: Number.NaN, longitude: -74.04 }, { authorized: true, latitude: 4.69, longitude: -74.04, accuracy: 5 }, { authorized: true, latitude: 4.69 }, null, [], 'Bogotá']) {
    const result = parseReport(report({ location }), now);
    assert.equal(result.ok, false, JSON.stringify(location));
    if (!result.ok) { assert.deepEqual(result.fields, ['location']); assert.equal(JSON.stringify(result).includes('4.69'), false); }
  }
});

test('the canonical report of a report without a location is the one it always had, and a location changes it', () => {
  const base = parseReport(report(), now); assert.ok(base.ok);
  const value = (base as { value: ReportInput }).value;
  assert.equal(canonicalReport(value), JSON.stringify(['claim-report.v1', value.policyId, value.eventType, value.occurredAt, value.place, value.description,
    [...value.evidence].sort((a, b) => a.fileId.localeCompare(b.fileId)).map(item => [item.fileId, item.contentType, item.byteSize, item.sha256])]));
  const located = { ...value, location: { latitude: 4.696944, longitude: -74.044167 } };
  assert.notEqual(canonicalReport(value), canonicalReport(located));
  assert.notEqual(canonicalReport(located), canonicalReport({ ...located, location: { latitude: 4.696945, longitude: -74.044167 } }));
});

test('the canonical report ignores the order of the files and changes with any declared value', () => {
  const base = parseReport(report(), now); assert.ok(base.ok);
  const value = (base as { value: ReportInput }).value;
  assert.equal(canonicalReport(value), canonicalReport({ ...value, evidence: [...value.evidence].reverse() }));
  for (const change of [{ description: value.description + '.' }, { place: null }, { occurredAt: '2026-09-09T18:56:00.000Z' }, { eventType: 'theft' as const }, { policyId: ids.otherPolicy }]) {
    assert.notEqual(canonicalReport(value), canonicalReport({ ...value, ...change }));
  }
  assert.equal(claimNumber(2026, 9127), 'SIN-2026-09127');
});

test('a report becomes one numbered case only after every declared file is received, and every repetition is safe', async () => {
  const { application, claims } = service();
  const created = await application.create(ownerA, report(), 'retry-key-0001', ids.trace);
  assert.equal(created.status, 'created');
  const draft = (created as { claim: DraftView }).claim;
  assert.equal(draft.state, 'draft'); assert.deepEqual(draft.evidence.map(file => file.state), ['pending', 'pending']);
  assert.equal((await application.create(ownerA, report({ evidence: [...report().evidence].reverse() }), 'retry-key-0001', ids.trace)).status, 'replayed');
  assert.equal((await application.create(ownerA, report({ description: description + ' Más detalle.' }), 'retry-key-0001', ids.trace)).status, 'idempotency_conflict');
  assert.equal(claims.size, 1, 'a retry never creates a second case');

  const upload = (fileId: string, bytes: Uint8Array, contentType: string, owner = ownerA, length: number | null = bytes.length) =>
    application.receive(owner, draft.claimId, fileId, { contentType, length, body: new Response(bytes).body }, ids.trace);
  assert.deepEqual(await application.submit(ownerA, draft.claimId, ids.trace), { status: 'incomplete', missing: [ids.file1, ids.file2] });
  assert.deepEqual(await upload(ids.file1, photo, 'image/jpeg'), { status: 'stored' });
  assert.deepEqual(await application.submit(ownerA, draft.claimId, ids.trace), { status: 'incomplete', missing: [ids.file2] }, 'a partial upload never claims reception');
  assert.deepEqual(await upload(ids.file1, photo, 'image/jpeg'), { status: 'already_received' });
  assert.deepEqual(await upload(ids.file2, video, 'video/mp4'), { status: 'stored' });
  const first = await application.submit(ownerA, draft.claimId, ids.trace);
  assert.equal(first.status, 'submitted');
  const again = await application.submit(ownerA, draft.claimId, ids.trace);
  assert.deepEqual(again, { ...first, status: 'already_submitted' });
  assert.equal((first as { claimNumber: string }).claimNumber, 'SIN-2026-00001');
  assert.deepEqual(await upload(ids.file2, video, 'video/mp4'), { status: 'already_received' }, 'a lost answer after submission can still be repeated');
});

test('uploads are refused for another customer, a wrong type or size, a corrupted body and a closed or unprovisioned report', async () => {
  const { application, claims } = service();
  const draft = ((await application.create(ownerA, report(), 'retry-key-0002', ids.trace)) as { claim: DraftView }).claim;
  const send = (owner: ReportOwner, fileId: string, bytes: Uint8Array, contentType: string | null, length: number | null) =>
    application.receive(owner, draft.claimId, fileId, { contentType, length, body: new Response(bytes).body }, ids.trace);
  assert.deepEqual(await send(ownerB, ids.file1, photo, 'image/jpeg', photo.length), { status: 'not_found' });
  assert.deepEqual(await application.submit(ownerB, draft.claimId, ids.trace), { status: 'not_found' });
  assert.equal((await application.create(ownerB, report(), 'retry-key-0003', ids.trace)).status, 'policy_not_found');
  assert.equal((await application.create(ownerA, report({ policyId: ids.otherPolicy }), 'retry-key-0006', ids.trace)).status, 'policy_not_found', 'a policy that is not issued yet has no coverage');
  assert.deepEqual(await send(ownerA, ids.file1, photo, 'image/png', photo.length), { status: 'content_type_mismatch' });
  assert.deepEqual(await send(ownerA, ids.file1, photo, null, photo.length), { status: 'content_type_mismatch' });
  assert.deepEqual(await send(ownerA, ids.file1, photo.slice(0, 10), 'image/jpeg', 10), { status: 'size_mismatch' });
  assert.deepEqual(await send(ownerA, ids.file1, photo, 'image/jpeg', null), { status: 'size_mismatch' });
  assert.deepEqual(await send(ownerA, ids.file1, new Uint8Array(photo.length).fill(1), 'image/jpeg', photo.length), { status: 'checksum_mismatch' });
  assert.equal([...claims.values()][0].files.get(ids.file1)?.state, 'pending', 'a corrupted upload is never recorded as received');
  assert.deepEqual(await send(ownerA, '90000000-0000-4000-8000-0000000000e9', photo, 'image/jpeg', photo.length), { status: 'not_found' });
  const closed = [...claims.values()][0]; closed.state = 'unassigned';
  assert.deepEqual(await send(ownerA, ids.file1, photo, 'image/jpeg', photo.length), { status: 'claim_not_draft' });
  const bare = service(null);
  const bareDraft = ((await bare.application.create(ownerA, report(), 'retry-key-0004', ids.trace)) as { claim: DraftView }).claim;
  assert.deepEqual(await bare.application.receive(ownerA, bareDraft.claimId, ids.file1, { contentType: 'image/jpeg', length: photo.length, body: new Response(photo).body }, ids.trace), { status: 'evidence_unavailable' });
  assert.deepEqual(await bare.application.submit(ownerA, bareDraft.claimId, ids.trace), { status: 'incomplete', missing: [ids.file1, ids.file2] });
  assert.equal((await service().application.create(ownerA, report({ occurredAt: '2025-06-01T10:00:00.000Z' }), 'retry-key-0005', ids.trace)).status, 'outside_coverage');
});

const schema = parse(readFileSync('packages/contracts/openapi/v1/claims.yaml', 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv);
ajv.addSchema({ ...schema, $id: 'https://solventa.test/claims' });
const check = (name: string, body: unknown) => {
  const validate = ajv.getSchema(`https://solventa.test/claims#/components/schemas/${name}`); assert.ok(validate, name);
  assert.equal(validate(body), true, `${name}: ${JSON.stringify(validate.errors)}`);
};
const granted = (change: Record<string, unknown> = {}) => ({ allowed: true, actor: { kind: 'user', channel: 'mobile', principal: { clientId: ids.clientA, subjectToken: ids.subjectA },
  operations: ['claims:report'], ...change } });
function http(access: unknown = granted(), evidenceStore: ClaimEvidenceStore<Stream> | null = memoryEvidence().evidence) {
  let authorization: unknown; const { application, claims } = service(evidenceStore);
  const app = createHttp({ authorizeFinancialAccess: async () => null, denyResourceAccess: async () => null, finance: {} as never,
    claimReport: { report: application, authorize: async input => { authorization = input; return access; } } });
  return { app, claims, authorization: () => authorization };
}
const url = (path = '') => `https://claims.example.invalid/api/v1/claims${path}`;
const bearer = { authorization: 'Bearer synthetic.mobile.token' };
const create = (api: ReturnType<typeof http>, body: unknown = report(), headers: Record<string, string> = {}) => api.app.request(url(), { method: 'POST', body: JSON.stringify(body),
  headers: { ...bearer, 'content-type': 'application/json', 'idempotency-key': 'retry-key-1001', ...headers } });
const put = (api: ReturnType<typeof http>, claimId: string, fileId: string, bytes: Uint8Array, contentType = 'image/jpeg', headers: Record<string, string> = {}) =>
  api.app.request(url(`/${claimId}/evidence/${fileId}`), { method: 'PUT', body: bytes, headers: { ...bearer, 'content-type': contentType, 'content-length': String(bytes.length), ...headers } });
const submit = (api: ReturnType<typeof http>, claimId: string) => api.app.request(url(`/${claimId}/submit`), { method: 'POST', headers: bearer });

test('HTTP runs the whole report with the native token, a fixed operation and contract-conformant answers', async () => {
  const api = http();
  const created = await create(api);
  assert.equal(created.status, 201); assert.equal(created.headers.get('cache-control'), 'no-store'); assert.match(created.headers.get('x-trace-id') ?? '', /^[0-9a-f-]{36}$/);
  assert.deepEqual(api.authorization(), { kind: 'mobile', operation: 'claims:report', token: 'synthetic.mobile.token' });
  const draft = await created.json(); check('ClaimReportDraft', draft); check('ClaimReportDraft', examples.draft);
  assert.equal((await create(api)).status, 200);
  assert.equal((await create(api, report({ place: 'Otro lugar' }))).status, 409);

  const early = await submit(api, draft.claimId);
  assert.equal(early.status, 409); const missing = await early.json(); check('ReportError', missing); assert.deepEqual(missing.missing, [ids.file1, ids.file2]);
  for (const [fileId, bytes, type] of [[ids.file1, photo, 'image/jpeg'], [ids.file2, video, 'video/mp4']] as const) {
    const response = await put(api, draft.claimId, fileId, bytes, type);
    assert.equal(response.status, 200); const receipt = await response.json(); check('EvidenceReceipt', receipt); assert.equal(receipt.state, 'verified');
  }
  assert.equal((await put(api, draft.claimId, ids.file1, photo)).status, 200, 'repeating a received file is acknowledged');
  const done = await submit(api, draft.claimId);
  assert.equal(done.status, 200); const receipt = await done.json(); check('ClaimReportReceipt', receipt); assert.match(receipt.claimNumber, /^SIN-\d{4}-\d{5}$/);
  const repeated = await (await submit(api, draft.claimId)).json();
  assert.deepEqual([repeated.claimNumber, repeated.submittedAt, repeated.state], [receipt.claimNumber, receipt.submittedAt, receipt.state], 'a repeated submit returns the same case');
  check('ClaimReportRequest', examples.request);
  check('ClaimReportReceipt', examples.submitted); check('ReportError', examples.incomplete); check('ReportError', examples.invalid);
});

test('HTTP refuses without a valid native credential before reading a body', async () => {
  for (const [status, error] of [[401, 'unauthorized'], [403, 'forbidden']] as const) {
    const api = http({ allowed: false, status, error });
    const response = await create(api); assert.equal(response.status, status); check('ReportError', await response.json()); assert.equal(api.claims.size, 0);
  }
  const api = http();
  for (const headers of [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer ' }]) {
    const response = await api.app.request(url(), { method: 'POST', body: JSON.stringify(report()), headers: { 'content-type': 'application/json', 'idempotency-key': 'retry-key-1001', ...headers } });
    assert.equal(response.status, 401); assert.equal(api.claims.size, 0);
  }
  const cases = [null, {}, { allowed: true, actor: { kind: 'partner' } }, granted({ channel: 'web' }), granted({ operations: ['claims:read'] }),
    granted({ principal: { clientId: 'not-a-uuid', subjectToken: ids.subjectA } }), { allowed: false, status: 503, error: 'access_unavailable' }];
  for (const access of cases) { const response = await create(http(access)); assert.equal(response.status, 503, JSON.stringify(access)); check('ReportError', await response.json()); }
});

test('HTTP validates the declaration, the media type and the key, and reports only field names', async () => {
  const api = http();
  const bad = await create(api, report({ description: 'corta', evidence: [] })); assert.equal(bad.status, 400);
  const body = await bad.json(); check('ReportError', body); assert.deepEqual(body.fields.sort(), ['description', 'evidence']); assert.equal(JSON.stringify(body).includes('corta'), false);
  assert.equal((await create(api, report(), { 'idempotency-key': 'short' })).status, 400);
  assert.equal((await create(api, report(), { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await api.app.request(url(), { method: 'POST', body: '{', headers: { ...bearer, 'content-type': 'application/json', 'idempotency-key': 'retry-key-1001' } })).status, 400);
  assert.equal((await create(api, report({ description: 'x'.repeat(40_000) }))).status, 400);
  assert.equal((await create(api, report({ policyId: ids.otherPolicy }))).status, 404, 'a policy that is not the caller\'s looks missing');
  assert.equal((await create(api, report({ occurredAt: '2025-06-01T10:00:00.000Z' }))).status, 422);
  assert.equal(api.claims.size, 0);
  for (const [method, path] of [['GET', '/90000000-0000-4000-8000-000000000001/submit'], ['PUT', '/90000000-0000-4000-8000-000000000001/submit']] as const) {
    const response = await api.app.request(url(path), { method, headers: bearer }); assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'POST');
  }
  const method = await api.app.request(url('/90000000-0000-4000-8000-000000000001/evidence/' + ids.file1), { method: 'POST', headers: bearer });
  assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'PUT');
  assert.equal((await submit(api, 'not-a-uuid')).status, 404);
});

test('HTTP evidence upload maps every refusal to a distinct status and keeps another customer\'s claim hidden', async () => {
  const api = http();
  const draft = await (await create(api)).json();
  assert.equal((await put(api, draft.claimId, ids.file1, photo, 'image/png')).status, 415);
  assert.equal((await put(api, draft.claimId, ids.file1, photo.slice(0, 5))).status, 400);
  assert.equal((await api.app.request(url(`/${draft.claimId}/evidence/${ids.file1}`), { method: 'PUT', body: photo, headers: { ...bearer, 'content-type': 'image/jpeg' } })).status, 400);
  const corrupted = await put(api, draft.claimId, ids.file1, new Uint8Array(photo.length).fill(1)); assert.equal(corrupted.status, 422); check('ReportError', await corrupted.json());
  assert.equal((await put(api, draft.claimId, '90000000-0000-4000-8000-0000000000e9', photo)).status, 404);
  assert.equal((await put(api, 'not-a-uuid', ids.file1, photo)).status, 404);
  const stranger = http(granted({ principal: { clientId: ids.clientB, subjectToken: ids.subjectB } }));
  const foreign = await stranger.app.request(url(`/${draft.claimId}/evidence/${ids.file1}`), { method: 'PUT', body: photo, headers: { ...bearer, 'content-type': 'image/jpeg', 'content-length': String(photo.length) } });
  assert.equal(foreign.status, 404);
  const unprovisioned = http(granted(), null);
  const noBucket = await put(unprovisioned, (await (await create(unprovisioned)).json()).claimId, ids.file1, photo);
  assert.equal(noBucket.status, 503); assert.equal((await noBucket.json()).error, 'evidence_unavailable');
  assert.equal(JSON.stringify(await (await submit(api, draft.claimId)).json()).includes('missing'), true);
  const closed = [...api.claims.values()][0]; closed.state = 'unassigned';
  assert.equal((await put(api, draft.claimId, ids.file1, photo)).status, 409);
});

test('the gateway carries the report: JSON declarations intact, evidence streamed byte for byte, oversize and unsized uploads refused before Policy', async () => {
  const api = http();
  let evidenceRequests = 0;
  const environment = { APP_ENV: 'local', POLICY: { fetch: (request: Request) => { if (request.method === 'PUT') evidenceRequests++; return api.app.request(request, undefined, { APP_ENV: 'local' } as PolicyEnv); } } } as unknown as WebEnv;
  const send = (path: string, init: RequestInit) => worker.fetch(new Request(`http://localhost:8787/api/v1/claims${path}`, { ...init, headers: { ...bearer, ...init.headers } }), environment);
  const created = await send('', { method: 'POST', body: JSON.stringify(report()), headers: { 'content-type': 'application/json', 'idempotency-key': 'retry-key-2001' } });
  assert.equal(created.status, 201, 'the JSON declaration is not truncated by the gateway');
  const draft = await created.json();
  const upload = await send(`/${draft.claimId}/evidence/${ids.file1}`, { method: 'PUT', body: photo, headers: { 'content-type': 'image/jpeg', 'content-length': String(photo.length) } });
  assert.equal(upload.status, 200); assert.equal(upload.headers.get('cache-control'), 'no-store');
  assert.equal([...api.claims.values()][0].files.get(ids.file1)?.state, 'verified', 'the file reaches Policy intact, so its checksum verifies');
  assert.equal(evidenceRequests, 1);
  const unsized = await send(`/${draft.claimId}/evidence/${ids.file2}`, { method: 'PUT', body: video, headers: { 'content-type': 'video/mp4' } });
  assert.equal(unsized.status, 400);
  const huge = await send(`/${draft.claimId}/evidence/${ids.file2}`, { method: 'PUT', body: video, headers: { 'content-type': 'video/mp4', 'content-length': String(MAX_EVIDENCE_BYTES + 1) } });
  assert.equal(huge.status, 400); check('ReportError', await huge.json());
  assert.equal(evidenceRequests, 1, 'a refused upload never reaches Policy');
  const down = await worker.fetch(new Request(`http://localhost:8787/api/v1/claims/${draft.claimId}/evidence/${ids.file2}`, { method: 'PUT', body: video, headers: { ...bearer, 'content-type': 'video/mp4', 'content-length': String(video.length) } }),
    { APP_ENV: 'local', POLICY: { fetch: async () => { throw new Error('down'); } } } as unknown as WebEnv);
  assert.equal(down.status, 503); assert.equal((await down.json()).error, 'service_unavailable');
});

test('the R2 adapter maps a checksum refusal, keeps other failures visible and confirms the stored size', async () => {
  const meta = { contentType: 'image/jpeg', byteSize: 10, sha256: 'a'.repeat(64) };
  const body = () => new Response(new Uint8Array(10)).body as ReadableStream<Uint8Array>;
  const bucket = (put: () => Promise<unknown>, size: number | null) => ({ put, head: async () => (size === null ? null : { size }) }) as unknown as R2Bucket;
  assert.equal(await new R2ClaimEvidence(bucket(async () => ({}), 10)).put('claims/a', body(), meta), 'stored');
  assert.equal(await new R2ClaimEvidence(bucket(async () => ({}), 9)).put('claims/a', body(), meta), 'size_mismatch');
  assert.equal(await new R2ClaimEvidence(bucket(async () => ({}), null)).put('claims/a', body(), meta), 'size_mismatch');
  for (const message of ['put: The SHA-256 checksum you specified did not match what we received. (10037)', 'put: The SHA-256 checksum you specified did not match what we received.']) {
    assert.equal(await new R2ClaimEvidence(bucket(async () => { throw new Error(message); }, 10)).put('claims/a', body(), meta), 'checksum_mismatch');
  }
  await assert.rejects(new R2ClaimEvidence(bucket(async () => { throw new Error('put: internal error (10001)'); }, 10)).put('claims/a', body(), meta), /internal error/);
});
