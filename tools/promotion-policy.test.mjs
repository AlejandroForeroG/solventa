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

function fixture(t) {
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
  commit('other-feature', 'Only dev should contain this feature');
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
  const checks = gitChecks(directory);
  const promotion = { base: 'staging', head: 'feat/quote', sourceSha, mergeSha, trialSha, deployedShas: [deployed], ...checks };
  return { git, commit, candidate, checks, promotion, deployed };
}

test('a feature can reach staging after testing in dev without including unrelated dev work', t => {
  const f = fixture(t);
  assert.equal(f.checks.sameTree(f.promotion.sourceSha, f.deployed), false);
  assert.equal(f.checks.sameTree(f.promotion.sourceSha, f.promotion.mergeSha), true);
  verifyPromotion(f.promotion);
});

test('a new integration revision must be in a successful dev deployment', t => {
  const f = fixture(t);
  f.git('switch', 'feat/quote-dev');
  const untested = f.commit('fix', 'not deployed yet');
  assert.throws(() => verifyPromotion({ ...f.promotion, trialSha: untested }), /no está incluida/);
  assert.throws(() => verifyPromotion({ ...f.promotion, deployedShas: [] }), /no está incluida/);
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
  assert.throws(() => verifyPromotion(changed), /no contiene el candidato/);
  f.git('switch', 'feat/quote-dev');
  f.git('merge', '--no-ff', '-m', 'test(ci): synchronize corrected base', 'feat/quote');
  const trialSha = f.git('rev-parse', 'HEAD');
  assert.throws(() => verifyPromotion({ ...changed, trialSha }), /no está incluida/);
  f.git('switch', 'dev');
  f.git('merge', '--no-ff', '-m', 'test(ci): integrate corrected trial', 'feat/quote-dev');
  verifyPromotion({ ...changed, trialSha, deployedShas: [f.git('rev-parse', 'HEAD')] });
});

test('an outdated base cannot promote an untested merge result', t => {
  const f = fixture(t);
  f.git('switch', 'staging');
  f.commit('released-change', 'new staging dependency');
  const mergeSha = f.candidate('candidate-outdated');
  assert.throws(() => verifyPromotion({ ...f.promotion, mergeSha }), /El merge cambia el candidato/);
});

test('a descendant deployment that reverted or overwrote the trial does not validate it', t => {
  for (const change of ['revert', 'overwrite']) {
    const f = fixture(t);
    f.git('switch', 'dev');
    if (change === 'revert') f.git('revert', '--no-edit', f.promotion.sourceSha);
    else f.commit('quote', 'another change replaced the trial behavior');
    const laterDeployment = f.git('rev-parse', 'HEAD');
    assert.equal(f.checks.isAncestor(f.promotion.trialSha, laterDeployment), true);
    assert.throws(() => verifyPromotion({ ...f.promotion, deployedShas: [laterDeployment] }), /mismo contenido/);
    verifyPromotion({ ...f.promotion, deployedShas: [laterDeployment, f.deployed] });
  }
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
  assert.throws(() => verifyPromotion({ ...release, deployedShas: [f.deployed] }), /no tiene Deploy exitoso en staging/);
  assert.throws(() => verifyPromotion({ ...release, head: 'dev' }), /Prod solo recibe/);
});

test('missing trials and invalid revisions fail closed', t => {
  const f = fixture(t);
  assert.throws(() => verifyPromotion({ ...f.promotion, trialSha: undefined }), /Falta la rama/);
  assert.throws(() => verifyPromotion({ ...f.promotion, head: 'feat/quote-dev' }), /rama base/);
  assert.throws(() => verifyPromotion({ ...f.promotion, sourceSha: 'invalid' }), /Invalid promotion revision/);
});
