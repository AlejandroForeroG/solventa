import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = /^[a-f0-9]{40}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const maxAge = 6 * 60 * 60 * 1000;
const archiveLimit = 64 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const command = (file, args, options = {}) => execFileSync(file, args, { windowsHide: true, timeout: 30_000, maxBuffer: archiveLimit, ...options });
const git = args => command('git', args, { encoding: 'utf8' }).trim();
const api = path => JSON.parse(command('gh', ['api', path], { encoding: 'utf8', maxBuffer: 512 * 1024 }));

export function validationKey(fingerprint) {
  const fields = ['tree', 'runnerOS', 'runnerArch', 'imageOS', 'imageVersion', 'node', 'npm', 'sqlImage'];
  assert.deepEqual(Object.keys(fingerprint).sort(), fields.toSorted());
  assert.ok(fields.every(field => typeof fingerprint[field] === 'string' && fingerprint[field].length > 0));
  assert.ok(sha.test(fingerprint.tree));
  assert.equal(fingerprint.runnerOS, 'Linux');
  assert.match(fingerprint.sqlImage, /@sha256:[a-f0-9]{64}$/);
  return hash(JSON.stringify(fields.map(field => fingerprint[field])));
}

export function artifactName(context) {
  return `validation-v1-${validationKey(context.fingerprint)}-${context.runId}-${context.attempt}`;
}

// These are data-only artifacts. Never extract or execute files from a prior run.
export function readReceiptArchive(bytes, expectedDigest) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= archiveLimit);
  assert.ok(digest.test(expectedDigest));
  assert.equal(`sha256:${hash(bytes)}`, expectedDigest);
  const directory = mkdtempSync(join(tmpdir(), 'solventa-validation-'));
  const archive = join(directory, 'receipt.zip');
  try {
    writeFileSync(archive, bytes);
    assert.equal(command('unzip', ['-Z', '-1', archive], { encoding: 'utf8' }).trim(), 'validation.json');
    return JSON.parse(command('unzip', ['-p', archive, 'validation.json'], { encoding: 'utf8', maxBuffer: 16 * 1024 }));
  } finally {
    unlinkSync(archive);
    rmdirSync(directory);
  }
}

export function verifyEvidence({ context, artifact, run, receipt, commit, jobs, now = Date.now() }) {
  try {
    assert.equal(context.trusted, true);
    assert.equal(artifact.name, artifactName({ ...context, runId: run.id, attempt: run.run_attempt }));
    assert.equal(artifact.expired, false);
    assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0);
    assert.ok(artifact.size_in_bytes > 0 && artifact.size_in_bytes <= archiveLimit && digest.test(artifact.digest));
    assert.equal(run.id, artifact.workflow_run.id);
    assert.notEqual(run.id, context.runId);
    assert.equal(run.repository.id, context.repositoryId);
    assert.equal(run.head_repository.id, context.repositoryId);
    assert.equal(run.repository.full_name.toLowerCase(), context.repository.toLowerCase());
    assert.equal(artifact.workflow_run.repository_id, context.repositoryId);
    assert.equal(artifact.workflow_run.head_repository_id, context.repositoryId);
    assert.equal(artifact.workflow_run.head_sha, run.head_sha);
    assert.equal(run.status, 'completed');
    assert.equal(run.conclusion, 'success');
    assert.ok(['.github/workflows/ci.yml', '.github/workflows/deploy.yml'].includes(run.path));
    assert.ok(['pull_request', 'push'].includes(run.event));
    assert.equal(receipt.schema, 1);
    assert.equal(receipt.fullValidation, true);
    assert.equal(receipt.trusted, true);
    assert.equal(receipt.runId, run.id);
    assert.equal(receipt.attempt, run.run_attempt);
    assert.equal(receipt.repositoryId, context.repositoryId);
    assert.equal(receipt.repository.toLowerCase(), context.repository.toLowerCase());
    assert.equal(receipt.event, run.event);
    assert.equal(receipt.sourceSha, run.head_sha);
    assert.ok(sha.test(receipt.revision) && sha.test(receipt.sourceSha));
    assert.equal(validationKey(receipt.fingerprint), validationKey(context.fingerprint));
    const completed = Date.parse(receipt.completedAt);
    const started = Date.parse(run.run_started_at);
    const updated = Date.parse(run.updated_at);
    assert.ok(Number.isFinite(completed) && completed >= started && completed < updated + 1000);
    assert.ok(now >= completed && now - completed <= maxAge);
    assert.ok(Number.isFinite(updated) && now >= updated && now - updated <= maxAge);
    assert.equal(commit.sha, receipt.revision);
    assert.equal(commit.tree.sha, context.fingerprint.tree);
    if (run.event === 'pull_request') {
      assert.equal(run.path, '.github/workflows/ci.yml');
      assert.ok(sha.test(receipt.baseSha));
      assert.deepEqual(commit.parents.map(parent => parent.sha), [receipt.baseSha, receipt.sourceSha]);
    } else {
      assert.equal(run.path, '.github/workflows/deploy.yml');
      assert.ok(['dev', 'staging', 'prod'].includes(run.head_branch));
      assert.equal(receipt.revision, run.head_sha);
    }
    const job = jobs.find(item => ['validate', 'validate / validate'].includes(item.name));
    assert.ok(job && job.status === 'completed' && job.conclusion === 'success');
    for (const name of ['Run npm run check', 'Run npm run infra:up', 'Run npm run infra:down', 'Write full validation receipt']) {
      assert.ok(job.steps.some(step => step.name === name && step.conclusion === 'success'));
    }
    return true;
  } catch {
    return false;
  }
}

export function findReusableValidation(context, { listArtifacts, getRun, readReceipt, getCommit, getJobs, now = Date.now() }) {
  if (!context.trusted) return undefined;
  // Bound both history and network work. Missing/unavailable evidence runs the full suite.
  try {
    const artifacts = listArtifacts(`validation-v1-${validationKey(context.fingerprint)}-`);
    assert.ok(Array.isArray(artifacts) && artifacts.length <= 100);
    for (const artifact of artifacts.slice(0, 10)) {
      try {
        if (artifact.expired || artifact.size_in_bytes > archiveLimit || !digest.test(artifact.digest ?? '')) continue;
        const run = getRun(artifact.workflow_run.id);
        if (run.id === context.runId || run.status !== 'completed' || run.conclusion !== 'success'
          || run.repository?.id !== context.repositoryId || run.head_repository?.id !== context.repositoryId
          || now - Date.parse(run.updated_at) > maxAge) continue;
        const receipt = readReceipt(artifact);
        assert.ok(sha.test(receipt.revision));
        const commit = getCommit(receipt.revision);
        const jobs = getJobs(run.id, run.run_attempt);
        if (verifyEvidence({ context, artifact, run, receipt, commit, jobs, now })) return { runId: run.id, revision: receipt.revision };
      } catch { /* An invalid candidate is not proof. Try another bounded candidate, then run all checks. */ }
    }
  } catch { /* API failure cannot authorize reuse. */ }
  return undefined;
}

function createContext() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const repository = process.env.GITHUB_REPOSITORY;
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const revision = git(['rev-parse', 'HEAD']);
  assert.equal(revision, process.env.VALIDATION_REVISION);
  const images = [...readFileSync('infra/compose.yml', 'utf8').matchAll(/^\s+image: (\S+)\s*$/gm)].map(match => match[1]);
  assert.ok(images.length > 0 && images.every(image => image === images[0]));
  command('docker', ['pull', images[0]], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 });
  const sqlImages = JSON.parse(command('docker', ['image', 'inspect', images[0], '--format', '{{json .RepoDigests}}'], { encoding: 'utf8' }));
  assert.ok(Array.isArray(sqlImages) && sqlImages.length === 1);
  const fingerprint = {
    tree: git(['rev-parse', 'HEAD^{tree}']), runnerOS: process.env.RUNNER_OS, runnerArch: process.env.RUNNER_ARCH,
    imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion,
    node: process.version, npm: command('npm', ['--version'], { encoding: 'utf8' }).trim(), sqlImage: sqlImages[0],
  };
  validationKey(fingerprint);
  const pull = event.pull_request;
  const sourceSha = pull ? pull.head.sha : process.env.GITHUB_SHA;
  assert.ok(sha.test(sourceSha));
  const trusted = process.env.GITHUB_EVENT_NAME === 'pull_request'
    ? pull?.head.repo.id === event.repository.id && pull?.base.repo.id === event.repository.id
    : process.env.GITHUB_EVENT_NAME === 'push' && ['dev', 'staging', 'prod'].includes(process.env.GITHUB_REF_NAME);
  return { schema: 1, fingerprint, revision, sourceSha, baseSha: pull?.base.sha ?? null, trusted,
    repository, repositoryId: event.repository.id, runId: Number(process.env.GITHUB_RUN_ID),
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT), event: process.env.GITHUB_EVENT_NAME };
}

function output(values) {
  for (const [key, value] of Object.entries(values)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [action, file] = process.argv.slice(2);
    if (action === 'context') {
      const context = createContext();
      writeFileSync(file, JSON.stringify(context));
      output({ artifact_name: artifactName(context), trusted: context.trusted });
    } else {
      const context = JSON.parse(readFileSync(file, 'utf8'));
      if (action === 'lookup') {
        const root = `repos/${context.repository}`;
        const proof = findReusableValidation(context, {
          listArtifacts: prefix => api(`${root}/actions/artifacts?per_page=100`).artifacts.filter(artifact => artifact.name.startsWith(prefix)),
          getRun: id => api(`${root}/actions/runs/${id}`),
          readReceipt: artifact => readReceiptArchive(command('gh', ['api', `${root}/actions/artifacts/${artifact.id}/zip`]), artifact.digest),
          getCommit: revision => api(`${root}/git/commits/${revision}`),
          getJobs: (id, attempt) => api(`${root}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`).jobs,
        });
        output({ reused: Boolean(proof), source_run: proof?.runId ?? '' });
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, proof
          ? `Validation reused from https://github.com/${context.repository}/actions/runs/${proof.runId} for identical tree ${context.fingerprint.tree} and runner/tooling/SQL image. No environment credentials or deploy checks were reused.\n`
          : 'No eligible validation receipt: execute the complete validation and SQL suites.\n');
      } else if (action === 'receipt') {
        assert.equal(context.trusted, true);
        assert.equal(git(['rev-parse', 'HEAD']), context.revision);
        command('git', ['diff', '--exit-code', 'HEAD', '--'], { stdio: ['ignore', 'ignore', 'pipe'] });
        mkdirSync(dirname(process.argv[4]), { recursive: true });
        writeFileSync(process.argv[4], JSON.stringify({ ...context, fullValidation: true, completedAt: new Date().toISOString() }));
      } else throw Error('Unknown validation action');
    }
  } catch {
    console.error('Validation evidence could not be prepared safely.');
    process.exitCode = 1;
  }
}
