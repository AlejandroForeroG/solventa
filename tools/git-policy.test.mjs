import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCommit, validateBranch, validatePullRequest } from './git-policy.mjs';
test('commit types, scope and length', () => {
  for (const type of ['feat','fix','refactor','test']) validateCommit(`${type}(identity): validate session\n\nDetails.`);
  for (const bad of ['chore(ci): change','feat: change','feat(web): ','feat(web): change ']) assert.throws(() => validateCommit(bad));
  validateCommit(`feat(web): ${'a'.repeat(139)}`);
  assert.throws(() => validateCommit(`feat(web): ${'a'.repeat(140)}`), /151 characters; the maximum is 150/);
  validateCommit('fix(mobile): Add initial mobile app structure with welcome screen and theme');
  validateCommit('fix(mobile): add initial app structure, welcome screen and theme');
});
test('work branches', () => {
  for (const branch of ['feat/enable-biometrics','feat/123','fix/expo-structure','refactor/identity','test/login']) validateBranch(branch);
  for (const branch of ['codex/infra','chore/login','feat/','feat/ABC-12','dev','prod','feat/a--b','']) assert.throws(() => validateBranch(branch));
});
test('PRs keep integration branches separate from staging candidates', () => {
  const pr = { title: 'refactor(ci): promote version', sameRepository: true };
  for (const type of ['feat', 'fix', 'refactor', 'test']) {
    validatePullRequest({...pr, head: `${type}/login-dev`, base: 'dev'});
    validatePullRequest({...pr, head: `${type}/login`, base: 'staging'});
  }
  validatePullRequest({...pr, head: 'staging', base: 'prod'});
  for (const [head,base] of [['feat/login','dev'],['feat/dev','dev'],['feat/login-dev','staging'],['dev','staging'],['feat/login','prod'],['test/login-dev','prod'],['dev','prod'],['prod','staging'],['feat/login','main']]) assert.throws(() => validatePullRequest({...pr,head,base}));
  assert.throws(() => validatePullRequest({...pr,head:'feat/login-dev',base:'dev',sameRepository:false}));
  assert.throws(() => validatePullRequest({...pr,head:'feat/login',base:'staging',sameRepository:false}));
  assert.throws(() => validatePullRequest({...pr,head:'feat/login-dev-dev',base:'dev'}));
  validatePullRequest({...pr,head:`feat/${'a'.repeat(63)}`,base:'staging'});
  validatePullRequest({...pr,head:`feat/${'a'.repeat(63)}-dev`,base:'dev'});
  assert.throws(() => validatePullRequest({...pr,head:`feat/${'a'.repeat(64)}`,base:'staging'}));
});
