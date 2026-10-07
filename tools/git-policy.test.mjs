import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCommit, validateBranch, validatePullRequest } from './git-policy.mjs';
test('commit types, scope and length', () => {
  for (const type of ['feat','fix','refactor','test']) validateCommit(`${type}(identity): validar sesión\n\nDetalle.`);
  for (const bad of ['chore(ci): cambio','feat: cambio','feat(web): ','feat(web): cambio ']) assert.throws(() => validateCommit(bad));
  validateCommit(`feat(web): ${'a'.repeat(139)}`);
  assert.throws(() => validateCommit(`feat(web): ${'a'.repeat(140)}`), /151 caracteres; el máximo es 150/);
  validateCommit('fix(mobile): Add initial mobile app structure with welcome screen and theme');
  validateCommit('fix(mobile): add initial app structure, welcome screen and theme');
});
test('work branches', () => {
  for (const branch of ['feat/activar-biometria','feat/123','fix/struct-expo','refactor/identity','test/login']) validateBranch(branch);
  for (const branch of ['codex/infra','chore/login','feat/','feat/ABC-12','dev','prod','feat/a--b','']) assert.throws(() => validateBranch(branch));
});
test('PRs cannot skip environments or originate from forks', () => {
  const pr = { title: 'refactor(ci): promover versión', sameRepository: true };
  for (const [head,base] of [['feat/login','dev'],['fix/struct-expo','dev'],['refactor/identity','dev'],['test/login','dev'],['dev','staging'],['staging','prod']]) validatePullRequest({...pr,head,base});
  for (const [head,base] of [['feat/login','prod'],['fix/login','staging'],['test/login','prod'],['dev','prod'],['prod','staging'],['feat/login','main']]) assert.throws(() => validatePullRequest({...pr,head,base}));
  assert.throws(() => validatePullRequest({...pr,head:'dev',base:'staging',sameRepository:false}));
});
