import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { actionCodeHash, artifactName, findReusableValidation, readReceiptArchive, validationKey, verifyEvidence } from './validation-reuse.mjs';

const now = Date.parse('2026-11-16T16:00:00Z');
const revision = 'a'.repeat(40);
const source = 'b'.repeat(40);
const base = 'c'.repeat(40);
function evidence() {
  const context = { trusted: true, repository: 'example/solventa', repositoryId: 42, runId: 200, attempt: 1,
    fingerprint: { tree: 'd'.repeat(40), runnerOS: 'Linux', runnerArch: 'X64', imageOS: 'ubuntu24',
      imageVersion: '20261116.1', node: 'v22.21.1', npm: '10.9.4', sqlImage: `cockroachdb/cockroach@sha256:${'e'.repeat(64)}`,
      checkoutAction: '1'.repeat(64), setupNodeAction: '2'.repeat(64) } };
  const run = { id: 100, repository: { id: 42, full_name: 'example/solventa' }, head_repository: { id: 42 },
    event: 'pull_request', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success',
    head_sha: source, run_attempt: 1, run_started_at: '2026-11-16T15:30:00Z', updated_at: '2026-11-16T15:50:05Z' };
  const receipt = { schema: 1, fullValidation: true, trusted: true, runId: 100, attempt: 1, repositoryId: 42,
    repository: context.repository, event: run.event, sourceSha: source, baseSha: base, revision,
    fingerprint: { ...context.fingerprint }, completedAt: '2026-11-16T15:50:00Z' };
  const artifact = { id: 123, name: artifactName({ ...context, runId: 100 }), expired: false, size_in_bytes: 512,
    digest: `sha256:${'f'.repeat(64)}`, workflow_run: { id: 100, repository_id: 42, head_repository_id: 42, head_sha: source } };
  const commit = { sha: revision, tree: { sha: context.fingerprint.tree }, parents: [{ sha: base }, { sha: source }] };
  const jobs = [{ name: 'validate', status: 'completed', conclusion: 'success', steps:
    ['Run npm run check', 'Run npm run infra:up', 'Run npm run infra:down', 'Write full validation receipt']
      .map(name => ({ name, conclusion: 'success' })) }];
  return { context, run, receipt, artifact, commit, jobs, now };
}

function lookup(value, overrides = {}) {
  return findReusableValidation(value.context, { now, listArtifacts: () => [value.artifact], getRun: () => value.run,
    readReceipt: () => value.receipt, getCommit: () => value.commit, getJobs: () => value.jobs, ...overrides });
}

test('identical tested trees can cross merge SHAs without repeating full validation', () => {
  const value = evidence();
  assert.equal(verifyEvidence(value), true);
  assert.deepEqual(lookup(value), { runId: 100, revision });
  const push = evidence();
  Object.assign(push.run, { event: 'push', path: '.github/workflows/deploy.yml', head_branch: 'staging', head_sha: revision });
  Object.assign(push.receipt, { event: 'push', sourceSha: revision });
  push.artifact.workflow_run.head_sha = revision;
  push.jobs[0].name = 'validate / validate';
  assert.equal(verifyEvidence(push), true);
});

test('every relevant code, runner, tooling and SQL image change requires full validation', () => {
  for (const field of Object.keys(evidence().context.fingerprint)) {
    const value = evidence();
    value.context.fingerprint[field] = field === 'tree' ? 'e'.repeat(40)
      : field === 'sqlImage' ? `cockroachdb/cockroach@sha256:${'a'.repeat(64)}` : `${value.context.fingerprint[field]}-changed`;
    assert.equal(lookup(value), undefined, field);
  }
  assert.throws(() => validationKey({ ...evidence().context.fingerprint, unrecognizedCondition: true }));
  assert.throws(() => validationKey({ ...evidence().context.fingerprint, imageVersion: '' }));
});

test('untrusted, incomplete, failed, cancelled, stale or replaced evidence cannot authorize reuse', () => {
  const changes = [
    value => { value.context.trusted = false; },
    value => { value.run.head_repository.id = 99; },
    value => { value.run.repository.id = 99; },
    value => { value.run.repository.full_name = 'elsewhere/solventa'; },
    value => { value.run.status = 'in_progress'; },
    value => { value.run.conclusion = 'failure'; },
    value => { value.run.conclusion = 'cancelled'; },
    value => { value.run.path = '.github/workflows/untrusted.yml'; },
    value => { value.run.event = 'workflow_dispatch'; },
    value => { value.run.run_attempt = 2; },
    value => { value.context.runId = value.run.id; },
    value => { value.artifact.expired = true; },
    value => { value.artifact.workflow_run.repository_id = 99; },
    value => { value.artifact.workflow_run.head_repository_id = 99; },
    value => { value.artifact.workflow_run.head_sha = base; },
    value => { value.artifact.digest = 'missing'; },
    value => { value.artifact.size_in_bytes = 65 * 1024; },
    value => { value.artifact.name = 'validation-unrelated'; },
    value => { value.receipt.schema = 2; },
    value => { value.receipt.fullValidation = false; },
    value => { value.receipt.trusted = false; },
    value => { value.receipt.sourceSha = base; },
    value => { value.receipt.repositoryId = 99; },
    value => { value.receipt.completedAt = '2026-11-16T08:00:00Z'; },
    value => { value.receipt.completedAt = '2026-11-16T16:30:00Z'; },
    value => { value.run.updated_at = '2026-11-16T08:00:00Z'; },
    value => { value.commit.sha = base; },
    value => { value.commit.tree.sha = source; },
    value => { value.commit.parents.reverse(); },
    value => { value.jobs[0].conclusion = 'failure'; },
    value => { value.jobs[0].steps[0].conclusion = 'skipped'; },
    value => { value.jobs[0].steps.at(-1).conclusion = 'skipped'; },
    value => { value.jobs = []; },
  ];
  for (const [index, change] of changes.entries()) {
    const value = evidence();
    change(value);
    assert.equal(verifyEvidence(value), false, `rejection ${index}`);
    assert.equal(lookup(value), undefined, `lookup rejection ${index}`);
  }
});

test('missing evidence and unavailable APIs fall back to all checks, with bounded lookup', () => {
  const value = evidence();
  assert.equal(lookup(value, { listArtifacts: () => [] }), undefined);
  assert.equal(lookup(value, { listArtifacts: () => { throw Error('API unavailable'); } }), undefined);
  assert.equal(lookup(value, { readReceipt: () => { throw Error('Invalid archive'); } }), undefined);
  assert.equal(lookup(value, { getCommit: () => { throw Error('Commit removed'); } }), undefined);
  let reads = 0;
  assert.equal(lookup(value, { listArtifacts: () => Array.from({ length: 100 }, () => value.artifact),
    getRun: () => { reads++; throw Error('Unavailable'); } }), undefined);
  assert.equal(reads, 10);
});

function archive(files) {
  const directory = mkdtempSync(join(tmpdir(), 'solventa-validation-test-'));
  const git = args => execFileSync('git', args, { cwd: directory, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(['init', '--quiet']);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);
    git(['add', '.']);
    const tree = git(['write-tree']).trim();
    return execFileSync('git', ['archive', '--format=zip', tree], { cwd: directory, windowsHide: true });
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('solventa-validation-test-'));
    rmSync(directory, { recursive: true, force: true });
  }
}

test('only the bounded, digest-verified data-only archive is read and never extracted', () => {
  const bytes = archive({ 'validation.json': JSON.stringify(evidence().receipt) });
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  assert.deepEqual(readReceiptArchive(bytes, digest), evidence().receipt);
  assert.throws(() => readReceiptArchive(Buffer.from('changed'), digest));
  assert.throws(() => readReceiptArchive(bytes, `sha256:${'0'.repeat(64)}`));
  const extra = archive({ 'validation.json': '{}', 'execute.sh': 'exit 0' });
  assert.throws(() => readReceiptArchive(extra, `sha256:${createHash('sha256').update(extra).digest('hex')}`));
  const oversized = archive({ 'validation.json': JSON.stringify({ value: 'a'.repeat(32 * 1024) }) });
  assert.throws(() => readReceiptArchive(oversized, `sha256:${createHash('sha256').update(oversized).digest('hex')}`));
  assert.throws(() => readReceiptArchive(Buffer.alloc(65 * 1024), digest));
});

test('a mutable allowed action tag cannot reuse validation after its downloaded code changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'solventa-action-test-'));
  try {
    const file = join(directory, 'action.yml');
    writeFileSync(file, 'runs: node20');
    const original = actionCodeHash(directory);
    assert.equal(actionCodeHash(directory), original);
    writeFileSync(file, 'runs: node24');
    assert.notEqual(actionCodeHash(directory), original);
    writeFileSync(join(directory, 'additional.js'), 'changed entrypoint');
    assert.notEqual(actionCodeHash(directory), original);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('solventa-action-test-'));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('workflow preserves all full-validation commands and isolated migration/publication gates', () => {
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const deploy = parse(readFileSync('.github/workflows/deploy.yml', 'utf8'));
  assert.equal(ci.jobs.policy.if, "github.event_name == 'pull_request'");
  assert.ok(!JSON.stringify(ci.jobs.policy).includes('steps.reuse'));
  const commands = ci.jobs.validate.steps.filter(step => step.run?.startsWith('npm '));
  assert.ok(commands.length >= 22);
  for (const step of commands) assert.equal(step.if, step.run === 'npm run infra:down'
    ? "always() && steps.reuse.outputs.reused != 'true'" : "steps.reuse.outputs.reused != 'true'");
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  for (const step of commands.filter(step => step.run.startsWith('npm run '))) assert.ok(scripts[step.run.slice(8)]);
  assert.equal(ci.permissions.actions, 'read');
  for (const job of Object.values(ci.jobs)) {
    for (const step of job.steps ?? []) if (step.uses) assert.ok(['actions/checkout@v4', 'actions/setup-node@v4', './.github/actions/publish-validation'].includes(step.uses));
  }
  assert.ok(!JSON.stringify(ci.jobs.validate).includes('secrets.'));
  for (const step of ci.jobs.validate.steps.filter(step => step.name?.includes('validation receipt'))) {
    assert.match(step.if, /steps\.context\.outputs\.trusted == 'true'/);
    assert.match(step.if, /steps\.reuse\.outputs\.reused != 'true'/);
  }
  assert.deepEqual(deploy.jobs.migrate.needs, ['resolve', 'validate']);
  assert.deepEqual(deploy.jobs.deploy.needs, ['resolve', 'validate', 'migrate']);
  assert.ok(!JSON.stringify(deploy.jobs.deploy).includes('MIGRATION_DATABASE_URL'));
  assert.ok(deploy.jobs.deploy.steps.some(step => step.run?.includes('schema-verify') && step.run.includes(':verify')));
  assert.equal(deploy.concurrency['cancel-in-progress'], false);
});
