import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { findDeployedSha, gitChecks, verifyPromotion } from './promotion-policy.mjs';

test('deployment history is consumed page by page and stops at a matching revision', () => {
  const wanted = 'b'.repeat(40);
  const calls = [];
  const result = findDeployedSha(page => {
    calls.push(page);
    assert.ok(page <= 3, 'Do not fetch the remaining history after a match');
    return { count: 100, candidates: [page === 3 ? wanted : 'a'.repeat(40)] };
  }, sha => sha === wanted);
  assert.equal(result, wanted);
  assert.deepEqual(calls, [1, 2, 3]);
});

test('deployment pagination terminates without a match and rejects invalid responses', () => {
  const calls = [];
  assert.equal(findDeployedSha(page => {
    calls.push(page);
    return { count: page === 1 ? 100 : 0, candidates: [] };
  }, () => false), undefined);
  assert.deepEqual(calls, [1, 2]);
  for (const response of [{ count: 101, candidates: [] }, { count: 0, candidates: ['a'.repeat(40)] }, { count: 1, candidates: ['invalid'] }]) {
    assert.throws(() => findDeployedSha(() => response, () => true), /Invalid deployment page/);
  }
});

function fixture(t, includeUnrelatedDevelopment = true) {
  const directory = mkdtempSync(join(tmpdir(), 'solventa-promotion-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('solventa-promotion-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'staging');
  git('config', 'user.name', 'Synthetic test');
  git('config', 'user.email', 'test@example.invalid');
  mkdirSync(join(directory, 'disabled-hooks'));
  git('config', 'core.hooksPath', join(directory, 'disabled-hooks'));
  const commit = (file, content) => {
    writeFileSync(join(directory, file), content);
    git('add', file);
    git('commit', '-m', 'test(ci): synthetic change');
    return git('rev-parse', 'HEAD');
  };
  const start = commit('baseline', 'stable');
  git('branch', 'prod', start);
  git('switch', '-c', 'dev');
  if (includeUnrelatedDevelopment) commit('other-feature', 'Only dev should contain this feature');
  git('switch', '-c', 'feat/quote', 'staging');
  const sourceSha = commit('quote', 'first version');
  git('switch', '-c', 'feat/quote-dev');
  git('merge', '--no-ff', '-m', 'test(ci): integrate dev', 'dev');
  const trialSha = git('rev-parse', 'HEAD');
  git('switch', 'dev');
  git('merge', '--no-ff', '-m', 'test(ci): integrate feature trial', 'feat/quote-dev');
  const deployed = git('rev-parse', 'HEAD');
  const candidate = (name = 'candidate') => {
    git('switch', '-c', name, 'staging');
    git('merge', '--no-ff', '-m', 'test(ci): stage isolated feature', 'feat/quote');
    return git('rev-parse', 'HEAD');
  };
  const mergeSha = candidate();
  const checks = gitChecks(directory, start, 'dev');
  const promotion = { base: 'staging', head: 'feat/quote', sourceSha, mergeSha, trialSha, deployedShas: [deployed], ...checks };
  return { git, commit, candidate, checks, promotion, deployed };
}

test('a feature can reach staging after testing in dev without including unrelated dev work', t => {
  const f = fixture(t);
  assert.equal(f.checks.sameTree(f.promotion.sourceSha, f.deployed), false);
  assert.equal(f.checks.sameTree(f.promotion.sourceSha, f.promotion.mergeSha), true);
  verifyPromotion(f.promotion);
  verifyPromotion({ ...f.promotion, head: 'feat/quote-dev' });
});

test('a deployed integration branch cannot promote unrelated dev history under any name', t => {
  const f = fixture(t);
  f.git('switch', '-c', 'candidate-integration', 'staging');
  f.git('merge', '--no-ff', '-m', 'test(ci): attempt integration promotion', f.promotion.trialSha);
  const mergeSha = f.git('rev-parse', 'HEAD');
  for (const head of ['feat/quote-validation', 'feat/quote-dev']) {
    assert.throws(() => verifyPromotion({ ...f.promotion, head, sourceSha: f.promotion.trialSha, mergeSha }), /unreleased dev history/);
  }
});

test('a candidate merged directly into dev can promote without a separate integration branch', t => {
  const f = fixture(t, false);
  assert.equal(f.promotion.sourceSha, f.promotion.trialSha);
  verifyPromotion(f.promotion);
});

test('released dev ancestry with the staging tree does not reject a direct candidate', t => {
  const f = fixture(t);
  f.git('switch', '-c', 'released-dev', 'staging');
  f.git('commit', '--allow-empty', '-m', 'test(ci): retain released merge history');
  const released = f.git('rev-parse', 'HEAD');
  f.git('switch', 'dev');
  f.git('merge', '--no-ff', '-m', 'test(ci): synchronize released history', 'released-dev');
  f.git('switch', 'feat/quote');
  f.git('merge', '--no-ff', '-m', 'test(ci): retain released ancestry', released);
  assert.equal(f.checks.isolatedCandidate(f.git('rev-parse', 'HEAD')), true);
});

test('a new base revision requires its own successful dev deployment', t => {
  const f = fixture(t);
  f.git('switch', 'feat/quote');
  const sourceSha = f.commit('fix', 'not deployed yet');
  const mergeSha = f.candidate('candidate-untested');
  assert.throws(() => verifyPromotion({ ...f.promotion, sourceSha, mergeSha }), /no successful dev deployment/);
  assert.throws(() => verifyPromotion({ ...f.promotion, deployedShas: [] }), /no successful dev deployment/);
});

test('deployment proof is immutable when the integration branch advances or is deleted', t => {
  const f = fixture(t);
  const testedIntegration = f.checks.deploymentTrial(f.deployed);
  assert.equal(testedIntegration, f.promotion.trialSha);
  verifyPromotion(f.promotion);
  f.git('switch', 'feat/quote-dev');
  f.commit('quote', 'future work that has not been deployed');
  verifyPromotion(f.promotion);
  f.git('switch', 'candidate');
  f.git('branch', '-D', 'feat/quote-dev');
  assert.equal(f.checks.deploymentTrial(f.deployed), testedIntegration);
  verifyPromotion(f.promotion);
});

test('a cherry-picked base change needs synchronization and a new trial deployment', t => {
  const f = fixture(t);
  f.git('switch', 'feat/quote-dev');
  const fix = f.commit('quote', 'corrected behavior');
  f.git('switch', 'feat/quote');
  f.git('cherry-pick', fix);
  const sourceSha = f.git('rev-parse', 'HEAD');
  const mergeSha = f.candidate('candidate-fixed');
  const changed = { ...f.promotion, sourceSha, mergeSha };
  assert.throws(() => verifyPromotion(changed), /no successful dev deployment/);
  f.git('switch', 'feat/quote-dev');
  f.git('merge', '--no-ff', '-m', 'test(ci): synchronize corrected base', 'feat/quote');
  const trialSha = f.git('rev-parse', 'HEAD');
  assert.throws(() => verifyPromotion({ ...changed, trialSha }), /no successful dev deployment/);
  f.git('switch', 'dev');
  f.git('merge', '--no-ff', '-m', 'test(ci): integrate corrected trial', 'feat/quote-dev');
  verifyPromotion({ ...changed, trialSha, deployedShas: [f.git('rev-parse', 'HEAD')] });
});

test('an outdated base cannot promote an untested merge result', t => {
  const f = fixture(t);
  f.git('switch', 'staging');
  f.commit('released-change', 'new staging dependency');
  const mergeSha = f.candidate('candidate-outdated');
  assert.throws(() => verifyPromotion({ ...f.promotion, mergeSha }), /The merge changes the candidate/);
});

test('a descendant deployment that reverted or overwrote the trial does not validate it', t => {
  for (const change of ['revert', 'overwrite']) {
    const f = fixture(t);
    f.git('switch', 'dev');
    if (change === 'revert') f.git('revert', '--no-edit', f.promotion.sourceSha);
    else f.commit('quote', 'another change replaced the trial behavior');
    const laterDeployment = f.git('rev-parse', 'HEAD');
    assert.equal(f.checks.isAncestor(f.promotion.trialSha, laterDeployment), true);
    assert.throws(() => verifyPromotion({ ...f.promotion, deployedShas: [laterDeployment] }), /tested integration tree/);
    verifyPromotion({ ...f.promotion, deployedShas: [laterDeployment, f.deployed] });
  }
});

test('a successful integration deployment may change candidate files', t => {
  for (const change of ['revert', 'overwrite']) {
    const f = fixture(t);
    f.git('switch', 'feat/quote-dev');
    if (change === 'revert') f.git('revert', '--no-edit', f.promotion.sourceSha);
    else f.commit('quote', 'overwritten candidate');
    f.git('switch', 'dev');
    f.git('merge', '--no-ff', '-m', 'test(ci): deploy changed integration', 'feat/quote-dev');
    const laterDeployment = f.git('rev-parse', 'HEAD');
    assert.equal(f.checks.isAncestor(f.promotion.sourceSha, laterDeployment), true);
    assert.equal(f.checks.sameTree(f.checks.deploymentTrial(laterDeployment), laterDeployment), true);
    verifyPromotion({ ...f.promotion, deployedShas: [laterDeployment] });
    verifyPromotion({ ...f.promotion, deployedShas: [laterDeployment, f.deployed] });
  }
});

test('unavailable deployment commits cannot establish proof or prevent a later match', t => {
  const f = fixture(t);
  const missing = 'f'.repeat(40);
  assert.equal(f.checks.deploymentTrial(missing), undefined);
  assert.equal(f.checks.deploymentTrial(f.git('rev-parse', 'HEAD:quote')), undefined);
  assert.equal(f.checks.deploymentTrial('invalid'), undefined);
  assert.throws(() => verifyPromotion({ ...f.promotion, deployedShas: [missing] }), /no successful dev deployment/);
  verifyPromotion({ ...f.promotion, deployedShas: [missing, f.deployed] });
  const found = findDeployedSha(page => ({ count: page === 1 ? 100 : 1, candidates: [page === 1 ? missing : f.deployed] }), sha => {
    const trial = f.checks.deploymentTrial(sha);
    return trial !== undefined && f.checks.isAncestor(f.promotion.sourceSha, trial) && f.checks.sameTree(trial, sha);
  });
  assert.equal(found, f.deployed);
});

test('Git repository errors still fail the deployment lookup', t => {
  const f = fixture(t);
  f.git('config', 'core.repositoryformatversion', '999');
  assert.throws(() => f.checks.deploymentTrial(f.deployed), /Command failed/);
});

test('a release requires a successful deployment of the exact staging candidate', t => {
  const f = fixture(t);
  f.git('switch', 'staging');
  f.git('merge', '--no-ff', '-m', 'test(ci): stage ready feature', 'feat/quote');
  const sourceSha = f.git('rev-parse', 'HEAD');
  f.git('switch', 'prod');
  f.git('merge', '--no-ff', '-m', 'test(ci): release staged candidate', 'staging');
  const release = { base: 'prod', head: 'staging', sourceSha, mergeSha: f.git('rev-parse', 'HEAD'), deployedShas: [sourceSha], ...f.checks };
  verifyPromotion(release);
  assert.throws(() => verifyPromotion({ ...release, deployedShas: [f.deployed] }), /no successful staging deployment/);
  assert.throws(() => verifyPromotion({ ...release, head: 'dev' }), /Prod only accepts/);
});

test('missing merge proof and invalid revisions fail closed', t => {
  const f = fixture(t);
  assert.throws(() => verifyPromotion({ ...f.promotion, deploymentTrial: () => undefined }), /no successful dev deployment/);
  assert.throws(() => verifyPromotion({ ...f.promotion, sourceSha: 'invalid' }), /Invalid promotion revision/);
});
