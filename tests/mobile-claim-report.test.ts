import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuthFailure } from '../apps/mobile/src/features/authentication/domain/session';
import { createClaimReportApi, type EvidenceUploader } from '../apps/mobile/src/features/claim-report/adapters/claim-report-api';
import { ActivePolicies } from '../apps/mobile/src/features/claim-report/application/active-policies';
import { ClaimReportFlow } from '../apps/mobile/src/features/claim-report/application/claim-report-flow';
import { ClaimReportFailure, type CaptureOutcome, type ClaimReportApi, type DraftReceipt, type EvidenceFiles, type SubmitReceipt } from '../apps/mobile/src/features/claim-report/application/ports';
import { admit, contentTypeOf, isReportableProduct, LIMITS, manifestOf, validate, type Draft, type EvidenceItem } from '../apps/mobile/src/features/claim-report/domain/report';

const baseUrl = 'https://dev.solventa.site';
const policyId = '20000000-0000-4000-8000-000000000001';
const now = new Date('2026-11-10T18:00:00.000Z');
const window = { from: new Date('2026-11-10T05:00:00.000Z'), until: new Date('2027-11-10T05:00:00.000Z') };
const description = 'Colisión por alcance en la Autopista Norte con Calle 116, sentido sur. El otro vehículo frenó de golpe.';
const photo = (id: string, size = 2_000_000): EvidenceItem => ({ id, uri: `file:///cache/${id}.jpg`, contentType: 'image/jpeg', byteSize: size, kind: 'photo' });
const draft = (change: Partial<Draft> = {}): Draft => ({ policyId, eventType: 'collision', occurredAt: new Date('2026-11-10T15:00:00.000Z'), place: '', description, evidence: [photo('a')], ...change });

test('picked files are normalized, and every limit is enforced before anything is sent', () => {
  assert.equal(contentTypeOf({ uri: 'file:///a.jpg', mimeType: 'image/jpg', byteSize: 1 }), 'image/jpeg');
  assert.equal(contentTypeOf({ uri: 'file:///a.HEIC', mimeType: null, byteSize: 1 }), 'image/heic');
  assert.equal(contentTypeOf({ uri: 'file:///a.mov', mimeType: 'video/quicktime', byteSize: 1 }), 'video/quicktime');
  assert.equal(contentTypeOf({ uri: 'file:///a.pdf', mimeType: 'application/pdf', byteSize: 1 }), null);
  assert.equal(contentTypeOf({ uri: 'file:///a', mimeType: null, byteSize: 1 }), null);
  const none: EvidenceItem[] = [];
  assert.deepEqual(admit(none, { uri: 'file:///a.pdf', mimeType: 'application/pdf', byteSize: 5 }, 'x'), { rejected: 'file_type' });
  assert.deepEqual(admit(none, { uri: 'file:///a.jpg', mimeType: 'image/jpeg', byteSize: 0 }, 'x'), { rejected: 'empty' });
  assert.deepEqual(admit(none, { uri: 'file:///a.jpg', mimeType: 'image/jpeg', byteSize: null }, 'x'), { rejected: 'unreadable' });
  assert.deepEqual(admit([photo('a', LIMITS.bytes - 10)], { uri: 'file:///b.jpg', mimeType: 'image/jpeg', byteSize: 11 }, 'x'), { rejected: 'total_size' });
  assert.equal('item' in admit([photo('a', LIMITS.bytes - 10)], { uri: 'file:///b.jpg', mimeType: 'image/jpeg', byteSize: 10 }, 'x'), true);
  const full = Array.from({ length: LIMITS.files }, (_, index) => photo(String(index), 1));
  assert.deepEqual(admit(full, { uri: 'file:///b.jpg', mimeType: 'image/jpeg', byteSize: 1 }, 'x'), { rejected: 'too_many' });
});

test('the declaration needs a type, an exact time inside the policy dates, a real description and at least one file', () => {
  assert.deepEqual(validate(draft(), window, now), []);
  const issues = (change: Partial<Draft>) => validate(draft(change), window, now).map(issue => `${issue.field}:${issue.code}`);
  assert.deepEqual(issues({ eventType: null }), ['eventType:required']);
  assert.deepEqual(issues({ occurredAt: new Date('2026-11-10T19:00:00.000Z') }), ['occurredAt:future']);
  assert.deepEqual(issues({ occurredAt: new Date('2026-11-10T04:59:00.000Z') }), ['occurredAt:before_coverage']);
  assert.deepEqual(issues({ description: 'demasiado corta' }), ['description:too_short']);
  assert.deepEqual(issues({ description: '   ' + 'x'.repeat(39) + '   ' }), ['description:too_short'], 'surrounding spaces do not count');
  assert.deepEqual(issues({ description: 'x'.repeat(LIMITS.description.max + 1) }), ['description:too_long']);
  assert.deepEqual(issues({ place: 'x'.repeat(LIMITS.place + 1) }), ['place:too_long']);
  assert.deepEqual(issues({ evidence: [] }), ['evidence:none']);
  assert.deepEqual(issues({ evidence: [photo('a', LIMITS.bytes), photo('b', 1)] }), ['evidence:total_size']);
  assert.deepEqual(validate(draft({ occurredAt: new Date('2027-11-11T00:00:00.000Z') }), { ...window, until: new Date('2027-11-10T05:00:00.000Z') }, new Date('2027-12-01T00:00:00.000Z')).map(issue => issue.code), ['after_coverage']);
  assert.deepEqual(issues({ eventType: null, description: '', evidence: [] }).sort(), ['description:too_short', 'eventType:required', 'evidence:none']);
});

test('the declaration sent to the server is exact, trimmed and carries no device path', () => {
  const manifest = manifestOf({ ...draft({ place: '  Calle 116  ', description: `  ${description}  ` }), eventType: 'collision' }, new Map([['a', 'f'.repeat(64)]]));
  assert.deepEqual(manifest, { policyId, eventType: 'collision', occurredAt: '2026-11-10T15:00:00.000Z', place: 'Calle 116', description,
    evidence: [{ fileId: 'a', contentType: 'image/jpeg', byteSize: 2_000_000, sha256: 'f'.repeat(64) }] });
  assert.equal(JSON.stringify(manifest).includes('file:///'), false);
  assert.equal('place' in manifestOf({ ...draft(), eventType: 'collision' }, new Map()), false);
});

// A server that keeps its own record of drafts, files and numbers, so a retry can be told apart from a new report.
function fakeServer() {
  const server = { drafts: new Map<string, { key: string; body: string; claimId: string; verified: Set<string> }>(), uploads: [] as string[], submits: 0, failNext: [] as ClaimReportFailure[], keys: [] as string[] };
  const api: ClaimReportApi = {
    async createDraft(manifest, key) {
      server.keys.push(key);
      const failure = server.failNext.shift(); if (failure) throw failure;
      const existing = server.drafts.get(key);
      const body = JSON.stringify(manifest);
      if (existing) { if (existing.body !== body) throw new ClaimReportFailure('conflict'); return receipt(existing); }
      const created = { key, body, claimId: `30000000-0000-4000-8000-${String(server.drafts.size + 1).padStart(12, '0')}`, verified: new Set<string>() };
      server.drafts.set(key, created);
      return receipt(created);
    },
    async upload(claimId, file) {
      const failure = server.failNext.shift(); if (failure) throw failure;
      server.uploads.push(file.id);
      [...server.drafts.values()].find(draft => draft.claimId === claimId)?.verified.add(file.id);
    },
    async submit(claimId) {
      const failure = server.failNext.shift(); if (failure) throw failure;
      const stored = [...server.drafts.values()].find(draft => draft.claimId === claimId)!;
      const declared = (JSON.parse(stored.body) as { evidence: { fileId: string }[] }).evidence.map(file => file.fileId);
      const missing = declared.filter(id => !stored.verified.has(id));
      if (missing.length) throw new ClaimReportFailure('incomplete', { missing });
      server.submits++;
      return { claimId, claimNumber: 'SIN-2026-00001', submittedAt: now.toISOString() } satisfies SubmitReceipt;
    },
  };
  const receipt = (stored: { claimId: string; body: string; verified: Set<string> }): DraftReceipt => ({ claimId: stored.claimId,
    evidence: (JSON.parse(stored.body) as { evidence: { fileId: string }[] }).evidence.map(file => ({ fileId: file.fileId, state: stored.verified.has(file.fileId) ? 'verified' : 'pending' })) });
  return { server, api };
}
const noFiles: EvidenceFiles = { thumbnail: async () => null, dispose: async () => {} };
const flowWith = (api: ClaimReportApi, digested: string[] = [], files: EvidenceFiles = noFiles) => {
  let counter = 0;
  const flow = new ClaimReportFlow({ policyId, window, api, now: () => now, newId: () => `40000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    digest: { sha256: async uri => { digested.push(uri); return 'a'.repeat(64); } }, files });
  flow.setEventType('collision'); flow.setOccurredAt(new Date('2026-11-10T15:00:00.000Z')); flow.setDescription(description);
  flow.add([{ uri: 'file:///cache/one.jpg', mimeType: 'image/jpeg', byteSize: 1000 }, { uri: 'file:///cache/two.mp4', mimeType: 'video/mp4', byteSize: 5000 }]);
  return flow;
};

test('a report is checked before sending, and a complete one ends with a single case number', async () => {
  const { server, api } = fakeServer();
  const flow = flowWith(api);
  flow.setDescription('muy corta');
  assert.equal(flow.review(), false);
  assert.deepEqual(flow.getSnapshot().issues.map(issue => issue.code), ['too_short']);
  await flow.send();
  assert.equal(server.drafts.size, 0, 'an invalid report never reaches the server');
  flow.setDescription(description);
  assert.equal(flow.review(), true);
  await flow.send();
  const phase = flow.getSnapshot().phase;
  assert.deepEqual(phase, { kind: 'submitted', claimNumber: 'SIN-2026-00001', submittedAt: now.toISOString(), files: 2, bytes: 6000 });
  assert.deepEqual(server.uploads.length, 2); assert.equal(server.submits, 1);
  await flow.send();
  assert.equal(server.submits, 1, 'sending again after success does nothing');
});

test('after an interruption the retry reuses the key and the declaration, so the server never holds a second draft', async () => {
  const { server, api } = fakeServer();
  const digested: string[] = [];
  const flow = flowWith(api, digested);
  server.failNext.push(new ClaimReportFailure('unavailable'), new ClaimReportFailure('unavailable'));
  await flow.send();
  assert.deepEqual(flow.getSnapshot().phase, { kind: 'failed', failure: 'unavailable', missing: 0 });
  await flow.send();
  assert.equal(flow.getSnapshot().phase.kind, 'failed');
  await flow.send();
  assert.equal(flow.getSnapshot().phase.kind, 'submitted');
  assert.equal(server.keys.length, 3, 'three attempts reached the server');
  assert.equal(new Set(server.keys).size, 1, 'and all carried the same key');
  assert.equal(server.drafts.size, 1);
  assert.equal(digested.length, 2, 'each file is hashed once');
  assert.equal(new Set(server.uploads).size, server.uploads.length, 'a file that arrived is never sent again');
  assert.equal(server.submits, 1);
});

test('a lost upload is named by the server and only that file travels again', async () => {
  const { server, api } = fakeServer();
  const flow = flowWith(api);
  const original = api.upload.bind(api);
  let calls = 0;
  api.upload = async (claimId, file) => { calls++; if (calls === 2) throw new ClaimReportFailure('unavailable'); return original(claimId, file); };
  await flow.send();
  assert.deepEqual(flow.getSnapshot().phase, { kind: 'failed', failure: 'unavailable', missing: 0 });
  assert.equal(server.submits, 0, 'a report with a missing file is never submitted');
  await flow.send();
  assert.equal(flow.getSnapshot().phase.kind, 'submitted');
  assert.equal(server.uploads.length, 2, 'the first file was not sent twice');
});

test('a server that reports missing files makes only those files travel again', async () => {
  const { server, api } = fakeServer();
  const flow = flowWith(api);
  const submit = api.submit.bind(api);
  let first = true;
  api.submit = async claimId => {
    if (first) { first = false; const stored = [...server.drafts.values()][0]; const lost = [...stored.verified][0]; stored.verified.delete(lost); throw new ClaimReportFailure('incomplete', { missing: [lost] }); }
    return submit(claimId);
  };
  await flow.send();
  assert.deepEqual(flow.getSnapshot().phase, { kind: 'failed', failure: 'incomplete', missing: 1 });
  await flow.send();
  assert.equal(flow.getSnapshot().phase.kind, 'submitted');
  assert.equal(server.uploads.length, 3, 'two files, plus the one the server reported lost');
});

test('editing after a failure starts a new declaration instead of reusing a stale key, and refused files are reported', async () => {
  const { server, api } = fakeServer();
  const flow = flowWith(api);
  server.failNext.push(new ClaimReportFailure('outside_coverage'));
  await flow.send();
  assert.deepEqual(flow.getSnapshot().phase, { kind: 'failed', failure: 'outside_coverage', missing: 0 });
  flow.setDescription(description + ' Hubo un testigo.');
  assert.equal(flow.getSnapshot().phase.kind, 'editing');
  await flow.send();
  assert.equal(new Set(server.keys).size, 2, 'a changed declaration gets its own key');
  assert.equal(flow.getSnapshot().phase.kind, 'submitted');
  flow.add([{ uri: 'file:///x.pdf', mimeType: 'application/pdf', byteSize: 1 }]);
  assert.equal(flow.getSnapshot().phase.kind, 'submitted', 'a submitted report is no longer editable');
});

test('rejected files are surfaced and a mismatched checksum discards the stale declaration', async () => {
  const { server, api } = fakeServer();
  const flow = flowWith(api);
  flow.add([{ uri: 'file:///x.pdf', mimeType: 'application/pdf', byteSize: 1 }, { uri: 'file:///y.jpg', mimeType: 'image/jpeg', byteSize: LIMITS.bytes }]);
  assert.deepEqual(flow.getSnapshot().rejected, ['file_type', 'total_size']);
  flow.dismissRejected();
  assert.deepEqual(flow.getSnapshot().rejected, []);
  server.failNext.push(new ClaimReportFailure('unavailable'), new ClaimReportFailure('integrity'));
  await flow.send();
  await flow.send();
  assert.deepEqual(flow.getSnapshot().phase, { kind: 'failed', failure: 'integrity', missing: 0 });
  await flow.send();
  assert.equal(flow.getSnapshot().phase.kind, 'submitted');
  assert.equal(new Set(server.keys).size, 2, 'the declaration was rebuilt after the checksum failed');
});

test('authentication failures are not retried as outages', async () => {
  const api: ClaimReportApi = { createDraft: async () => { throw new AuthFailure('forbidden'); }, upload: async () => {}, submit: async () => { throw new Error('unreachable'); } };
  const flow = flowWith(api);
  await flow.send();
  assert.deepEqual(flow.getSnapshot().phase, { kind: 'failed', failure: 'forbidden', missing: 0 });
  const expired = flowWith({ ...api, createDraft: async () => { throw new AuthFailure('unauthorized'); } });
  await expired.send();
  assert.deepEqual(expired.getSnapshot().phase, { kind: 'failed', failure: 'unauthorized', missing: 0 });
});

const session = { execute: <T>(operation: (token: string) => Promise<T>) => operation('synthetic.jwt.token') };
const json = (body: unknown, status = 200, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });
const traceId = '50000000-0000-4000-8000-0000000000f0';
const claimId = '30000000-0000-4000-8000-000000000001';
const fileId = '40000000-0000-4000-8000-000000000001';
const uploaded: EvidenceUploader = async () => ({ status: 200, body: JSON.stringify({ fileId, state: 'verified', traceId }) });
const http = (respond: (url: string, init: RequestInit) => Response | Promise<Response>, uploader: EvidenceUploader = uploaded) =>
  createClaimReportApi(baseUrl, session, uploader, (async (url: string, init: RequestInit) => respond(url, init)) as typeof fetch);
const manifest = manifestOf({ ...draft(), eventType: 'collision' }, new Map([['a', 'f'.repeat(64)]]));

test('the draft is posted with the token, the retained key and no cookies, and only a valid answer is accepted', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const receipt = await http((url, init) => { seen = { url, init }; return json({ claimId, state: 'draft', evidence: [{ fileId, state: 'pending' }], traceId }, 201); }).createDraft(manifest, 'retry-key-0001');
  assert.equal(seen?.url, `${baseUrl}/api/v1/claims`);
  assert.equal(seen?.init.method, 'POST'); assert.equal(seen?.init.credentials, 'omit');
  assert.deepEqual(seen?.init.headers, { Accept: 'application/json', Authorization: 'Bearer synthetic.jwt.token', 'Content-Type': 'application/json', 'Idempotency-Key': 'retry-key-0001' });
  assert.deepEqual(JSON.parse(String(seen?.init.body)), manifest);
  assert.deepEqual(receipt, { claimId, evidence: [{ fileId, state: 'pending' }] });
  for (const body of [{ claimId: 'nope', evidence: [] }, { claimId, evidence: 'x' }, { claimId, evidence: [{ fileId, state: 'stored' }] }, '{', '[]']) {
    await assert.rejects(http(() => json(body, 200)).createDraft(manifest, 'retry-key-0001'), (error: ClaimReportFailure) => error.code === 'invalid_response');
  }
  await assert.rejects(http(() => json({ claimId, evidence: [] }, 200, 'text/html')).createDraft(manifest, 'retry-key-0001'), (error: ClaimReportFailure) => error.code === 'invalid_response');
});

test('an upload that exceeds its deadline is cancelled and has stopped before the outage is reported', async () => {
  const events: string[] = [];
  const slow: EvidenceUploader = ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => setTimeout(() => { events.push('stopped'); reject(new Error('cancelled')); }, 5), { once: true });
  });
  const api = createClaimReportApi(baseUrl, session, slow, (async () => json({})) as typeof fetch, 20);
  await assert.rejects(api.upload(claimId, photo('a')).finally(() => events.push('reported')), (error: ClaimReportFailure) => error.code === 'unavailable');
  assert.deepEqual(events, ['stopped', 'reported']);
  const late: EvidenceUploader = async ({ signal }) => { await new Promise(resolve => setTimeout(resolve, 40)); return signal.aborted ? { status: 200, body: JSON.stringify({ fileId, state: 'verified', traceId }) } : { status: 500, body: '' }; };
  await assert.rejects(createClaimReportApi(baseUrl, session, late, (async () => json({})) as typeof fetch, 10).upload(claimId, { ...photo('a'), id: fileId }), (error: ClaimReportFailure) => error.code === 'unavailable');
});

test('every refusal of the contract becomes a distinct failure and an outage is never read as a contract error', async () => {
  const failure = (status: number, body: unknown) => http(() => json(body, status)).createDraft(manifest, 'retry-key-0001').then(() => 'ok', (error: ClaimReportFailure | AuthFailure) => error instanceof AuthFailure ? `auth:${error.kind}` : error.code);
  assert.equal(await failure(401, { error: 'unauthorized', traceId }), 'auth:unauthorized');
  assert.equal(await failure(403, { error: 'forbidden', traceId }), 'auth:forbidden');
  assert.equal(await failure(404, { error: 'not_found', traceId }), 'not_found');
  assert.equal(await failure(400, { error: 'invalid_request', fields: ['description'], traceId }), 'invalid');
  assert.equal(await failure(409, { error: 'idempotency_conflict', traceId }), 'conflict');
  assert.equal(await failure(415, { error: 'unsupported_media_type', traceId }), 'media');
  assert.equal(await failure(422, { error: 'outside_coverage', traceId }), 'outside_coverage');
  assert.equal(await failure(422, { error: 'checksum_mismatch', traceId }), 'integrity');
  assert.equal(await failure(503, { error: 'evidence_unavailable', traceId }), 'unavailable');
  assert.equal(await failure(429, 'slow down'), 'unavailable');
  assert.equal(await failure(418, 'teapot'), 'invalid_response');
  await assert.rejects(http(() => { throw new Error('offline'); }).createDraft(manifest, 'retry-key-0001'), (error: ClaimReportFailure) => error.code === 'unavailable');
  const submitted = await http(() => json({ error: 'evidence_incomplete', missing: [fileId], traceId }, 409)).submit(claimId).then(() => null, (error: ClaimReportFailure) => error);
  assert.deepEqual([submitted?.code, submitted?.detail], ['incomplete', { missing: [fileId] }]);
});

test('an evidence file is sent to its own address with its type, and a bad receipt is not trusted', async () => {
  let sent: Parameters<EvidenceUploader>[0] | undefined;
  const item = { id: fileId, uri: 'file:///cache/a.jpg', contentType: 'image/jpeg' as const, byteSize: 10, kind: 'photo' as const };
  await http(() => json({}), async input => { sent = input; return { status: 200, body: JSON.stringify({ fileId, state: 'verified', traceId }) }; }).upload(claimId, item);
  assert.ok(sent);
  const { signal, ...rest } = sent;
  assert.equal(signal.aborted, false);
  assert.deepEqual(rest, { url: `${baseUrl}/api/v1/claims/${claimId}/evidence/${fileId}`, uri: item.uri, contentType: 'image/jpeg', token: 'synthetic.jwt.token' });
  const result = (status: number, body: unknown) => http(() => json({}), async () => ({ status, body: JSON.stringify(body) })).upload(claimId, item).then(() => 'ok', (error: ClaimReportFailure | AuthFailure) => error instanceof AuthFailure ? `auth:${error.kind}` : error.code);
  assert.equal(await result(200, { fileId: 'other', state: 'verified' }), 'invalid_response');
  assert.equal(await result(200, { fileId, state: 'pending' }), 'invalid_response');
  assert.equal(await result(422, { error: 'checksum_mismatch' }), 'integrity');
  assert.equal(await result(401, {}), 'auth:unauthorized');
  assert.equal(await result(409, { error: 'claim_not_draft' }), 'conflict');
  assert.equal(await http(() => json({}), async () => { throw new Error('network'); }).upload(claimId, item).then(() => 'ok', (error: ClaimReportFailure) => error.code), 'unavailable');
});

test('the submission accepts only the case number of the claim it asked for', async () => {
  const ok = await http(() => json({ claimId, claimNumber: 'SIN-2026-09127', state: 'unassigned', submittedAt: now.toISOString(), traceId })).submit(claimId);
  assert.deepEqual(ok, { claimId, claimNumber: 'SIN-2026-09127', submittedAt: now.toISOString() });
  for (const body of [{ claimId: 'other', claimNumber: 'SIN-2026-09127', submittedAt: now.toISOString() }, { claimId, claimNumber: 'SIN-26-1', submittedAt: now.toISOString() }, { claimId, claimNumber: 'SIN-2026-09127', submittedAt: 'soon' }]) {
    await assert.rejects(http(() => json(body)).submit(claimId), (error: ClaimReportFailure) => error.code === 'invalid_response');
  }
});

test('only a mortgage life policy can be reported, because flight delay pays on its own', () => {
  assert.equal(isReportableProduct('vida_hipotecario'), true);
  assert.equal(isReportableProduct('flight_delay'), false);
  assert.equal(isReportableProduct('anything_else'), false);
});

test('the policy list says when older policies were not read, so the screen never claims there are none', async () => {
  const policy = (product: string) => ({ policyId, product }) as never;
  const read = async (hasMore: boolean) => {
    const options = new ActivePolicies(async () => ({ policies: [policy('flight_delay'), policy('vida_hipotecario')], hasMore }), item => isReportableProduct((item as { product: string }).product), () => now.getTime());
    await options.refresh();
    return options.getSnapshot();
  };
  assert.deepEqual(await read(true), { status: 'ready', policies: [policy('vida_hipotecario')], partial: true });
  assert.deepEqual(await read(false), { status: 'ready', policies: [policy('vida_hipotecario')], partial: false });
  const failing = new ActivePolicies(async () => { throw new Error('offline'); }, () => true, () => now.getTime());
  await failing.refresh();
  assert.deepEqual(failing.getSnapshot(), { status: 'failed' });
});

// A report with nothing attached yet, so a test sees only the files it adds.
const bareFlow = (api: ClaimReportApi, files: EvidenceFiles) => {
  let counter = 0;
  return new ClaimReportFlow({ policyId, window, api, now: () => now, newId: () => `50000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`, digest: { sha256: async () => 'a'.repeat(64) }, files });
};
const settle = () => new Promise(resolve => setImmediate(resolve));
// Thumbnails answer through a table: a path, null for a failure or a thrown error. Every deletion is recorded.
const recordingFiles = (thumbnails: Record<string, string | null | 'throws'> = {}) => {
  const disposed: string[] = [];
  const files: EvidenceFiles = {
    thumbnail: async uri => { const made = thumbnails[uri]; if (made === 'throws') throw new Error('codec'); return made ?? null; },
    dispose: async uris => { disposed.push(...uris); },
  };
  return { files, disposed };
};
const owned = (uri: string, mimeType: string, byteSize = 1000) => ({ uri, mimeType, byteSize, owned: true });
const video = (id: string) => ({ ...owned(`file:///cache/${id}.mp4`, 'video/mp4', 5000), });

test('camera denial leaves the existing file option available, and only confirmation includes the document in the submitted claim', async () => {
  const { server, api } = fakeServer();
  const { files, disposed } = recordingFiles();
  const flow = flowWith(api, [], files);
  await flow.pickDocument(async () => ({ status: 'permission', permission: 'camera', canAskAgain: false }));
  assert.deepEqual(flow.getSnapshot().document, { kind: 'permission', canAskAgain: false });

  const candidate = owned('file:///cache/receipt.png', 'image/png');
  await flow.pickDocument(async () => ({ status: 'ok', candidates: [candidate] }));
  const pending = flow.getSnapshot().document;
  assert.equal(pending.kind, 'review');
  assert.equal(flow.getSnapshot().draft.evidence.length, 2);
  assert.equal(flow.review(), false);
  await flow.send();
  assert.equal(server.drafts.size, 0);

  flow.attachDocument();
  flow.attachDocument();
  assert.equal(flow.getSnapshot().draft.evidence.length, 3);
  assert.equal(flow.review(), true);
  await flow.send();
  const [claim] = server.drafts.values();
  const file = { fileId: pending.item.id, contentType: 'image/png', byteSize: candidate.byteSize, sha256: 'a'.repeat(64) };
  assert.deepEqual(JSON.parse(claim.body).evidence[2], file);
  assert.equal(JSON.parse(claim.body).policyId, policyId);
  assert.equal(claim.verified.has(file.fileId), true);
  assert.equal(server.uploads.filter(id => id === file.fileId).length, 1);
  assert.deepEqual(flow.getSnapshot().phase, { kind: 'submitted', claimNumber: 'SIN-2026-00001', submittedAt: now.toISOString(), files: 3, bytes: 7000 });
  assert.deepEqual(disposed, [candidate.uri]);
});

test('document review rejects unsupported or oversized files and releases discarded copies', async () => {
  const { files, disposed } = recordingFiles();
  const flow = bareFlow(fakeServer().api, files);
  const pdf = owned('file:///cache/receipt.pdf', 'application/pdf');
  const clip = video('clip');
  const oversized = owned('file:///cache/large.jpg', 'image/jpeg', LIMITS.bytes + 1);
  for (const [candidate, reason] of [[pdf, 'file_type'], [clip, 'file_type'], [oversized, 'total_size']] as const) {
    await flow.pickDocument(async () => ({ status: 'ok', candidates: [candidate] }));
    assert.deepEqual(flow.getSnapshot().document, { kind: 'failed', reason });
  }

  const receipt = owned('file:///cache/receipt.jpg', 'image/jpeg');
  await flow.pickDocument(async () => ({ status: 'ok', candidates: [receipt] }));
  flow.discardDocument();
  flow.attachDocument();
  assert.deepEqual(flow.getSnapshot().draft.evidence, []);
  assert.deepEqual(flow.getSnapshot().document, { kind: 'idle' });
  assert.deepEqual(disposed, [pdf.uri, clip.uri, oversized.uri, receipt.uri]);
});

test('leaving a report releases pending document copies, including results arriving after leaving', async () => {
  const { files, disposed } = recordingFiles();
  const flow = bareFlow(fakeServer().api, files);
  const pending = owned('file:///cache/preview.jpg', 'image/jpeg');
  await flow.pickDocument(async () => ({ status: 'ok', candidates: [pending] }));
  await flow.dispose();
  flow.open();
  const late = owned('file:///cache/late.png', 'image/png');
  const picker = Promise.withResolvers<CaptureOutcome>();
  const selection = flow.pickDocument(() => picker.promise);
  await flow.dispose();
  picker.resolve({ status: 'ok', candidates: [late] });
  await selection;

  flow.open();
  const original = { ...owned('file:///external/original.jpg', 'image/jpeg'), owned: false };
  await flow.pickDocument(async () => ({ status: 'ok', candidates: [original] }));
  await flow.dispose();
  assert.deepEqual(flow.getSnapshot().document, { kind: 'idle' });
  assert.deepEqual(disposed, [pending.uri, late.uri]);
});

test('a video is identified by a thumbnail made from it, and a failure to make one is a state of its own', async () => {
  const { files } = recordingFiles({ 'file:///cache/ok.mp4': 'file:///cache/ok-thumb.jpg', 'file:///cache/none.mp4': null, 'file:///cache/boom.mp4': 'throws' });
  const flow = bareFlow(fakeServer().api, files);
  flow.add([video('ok'), video('none'), video('boom'), owned('file:///cache/photo.jpg', 'image/jpeg')]);
  const evidence = () => flow.getSnapshot().draft.evidence;
  assert.deepEqual(evidence().filter(item => item.kind === 'video').map(item => item.preview), [{ status: 'pending' }, { status: 'pending' }, { status: 'pending' }]);
  await settle();
  const previews = Object.fromEntries(evidence().map(item => [item.uri.split('/').pop(), item.preview]));
  assert.deepEqual(previews['ok.mp4'], { status: 'ready', uri: 'file:///cache/ok-thumb.jpg' });
  assert.deepEqual(previews['none.mp4'], { status: 'failed' });
  assert.deepEqual(previews['boom.mp4'], { status: 'failed' });
  assert.equal(previews['photo.jpg'], undefined, 'a photo is its own preview');
  assert.equal(flow.review(), false, 'a preview never changes the rules of the report');
});

test('a removed, replaced or rejected file is released with its thumbnail, and a file the app does not own never is', async () => {
  const { files, disposed } = recordingFiles({ 'file:///cache/one.mp4': 'file:///cache/one-thumb.jpg' });
  const flow = bareFlow(fakeServer().api, files);
  flow.add([video('one'), { uri: 'file:///gallery/original.jpg', mimeType: 'image/jpeg', byteSize: 1000 }, owned('file:///cache/doc.pdf', 'application/pdf')]);
  await settle();
  assert.deepEqual(disposed, ['file:///cache/doc.pdf'], 'a rejected copy is released at once');
  const ids = Object.fromEntries(flow.getSnapshot().draft.evidence.map(item => [item.uri, item.id]));
  flow.remove(ids['file:///gallery/original.jpg']);
  await settle();
  assert.deepEqual(disposed, ['file:///cache/doc.pdf'], 'a gallery original is only forgotten');
  flow.remove(ids['file:///cache/one.mp4']);
  await settle();
  assert.deepEqual(disposed.slice(1).sort(), ['file:///cache/one-thumb.jpg', 'file:///cache/one.mp4']);
  flow.add([owned('file:///cache/replacement.jpg', 'image/jpeg')]);
  assert.equal(flow.getSnapshot().draft.evidence.length, 1, 'the replacement takes the place of what was removed');
});

test('the files stay for a retry after a failed send and are released once the report is filed', async () => {
  const { server, api } = fakeServer();
  const { files, disposed } = recordingFiles();
  const flow = flowWith(api, [], files);
  flow.add([owned('file:///cache/extra.jpg', 'image/jpeg')]);
  server.failNext.push(new ClaimReportFailure('unavailable'));
  await flow.send();
  await settle();
  assert.equal(flow.getSnapshot().phase.kind, 'failed');
  assert.deepEqual(disposed, [], 'a retry still needs every file');
  await flow.send();
  await settle();
  assert.equal(flow.getSnapshot().phase.kind, 'submitted');
  assert.deepEqual(disposed, ['file:///cache/extra.jpg'], 'only the copy the app made is deleted; the files of the fixture are not owned');
});

test('an abandoned report releases everything, and a thumbnail that arrives afterwards is deleted instead of shown', async () => {
  let finish: (uri: string) => void = () => {};
  const disposed: string[] = [];
  const files: EvidenceFiles = { thumbnail: () => new Promise(resolve => { finish = resolve; }), dispose: async uris => { disposed.push(...uris); } };
  const flow = bareFlow(fakeServer().api, files);
  flow.add([video('late'), owned('file:///cache/kept.jpg', 'image/jpeg')]);
  await flow.dispose();
  assert.deepEqual(disposed.sort(), ['file:///cache/kept.jpg', 'file:///cache/late.mp4']);
  assert.equal(flow.getSnapshot().draft.evidence.length, 0);
  finish('file:///cache/late-thumb.jpg');
  await settle();
  assert.ok(disposed.includes('file:///cache/late-thumb.jpg'));
  assert.equal(flow.getSnapshot().draft.evidence.length, 0, 'nothing is shown for a report that no longer exists');
  const { server, api } = fakeServer();
  const second = flowWith(api, [], files);
  await second.dispose();
  second.setDescription(description);
  assert.equal(server.drafts.size, 0, 'releasing an empty report changes nothing');
});

test('a file that arrives from the camera after the report was abandoned is released, and a report that is opened again accepts files', async () => {
  const { files, disposed } = recordingFiles({ 'file:///cache/late.mp4': 'file:///cache/late-thumb.jpg' });
  const flow = bareFlow(fakeServer().api, files);
  await flow.dispose();
  flow.add([video('late'), owned('file:///cache/late.jpg', 'image/jpeg')]);
  await settle();
  assert.deepEqual(disposed.sort(), ['file:///cache/late.jpg', 'file:///cache/late.mp4']);
  assert.equal(flow.getSnapshot().draft.evidence.length, 0, 'nothing is admitted into an abandoned report');
  flow.open();
  flow.add([owned('file:///cache/again.jpg', 'image/jpeg')]);
  assert.equal(flow.getSnapshot().draft.evidence.length, 1, 'the screen mounted again by React keeps working');
});
