import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCommit, validateBranch, validatePullRequest } from './git-policy.mjs';
test('commit types, scope and length', () => {
  for (const type of ['feat','fix','refactor','test']) validateCommit(`${type}(identity): validar sesión\n\nDetalle.`);
  for (const bad of ['chore(ci): cambio','feat: cambio','feat(web): ','feat(web): cambio ',`feat(web): ${'a'.repeat(63)}`]) assert.throws(() => validateCommit(bad));
  validateCommit(`feat(web): ${'a'.repeat(61)}`);
});
test('feature branches', () => {
  for (const branch of ['feat/activar-biometria','feat/123']) validateBranch(branch);
  for (const branch of ['codex/infra','fix/login','feat/','feat/ABC-12','dev','prod','feat/a--b','']) assert.throws(() => validateBranch(branch));
});
test('PRs cannot skip environments or originate from forks', () => {
  const pr = { title: 'refactor(ci): promover versión', sameRepository: true };
  for (const [head,base] of [['feat/login','dev'],['dev','staging'],['staging','prod']]) validatePullRequest({...pr,head,base});
  for (const [head,base] of [['feat/login','prod'],['dev','prod'],['prod','staging'],['feat/login','main']]) assert.throws(() => validatePullRequest({...pr,head,base}));
  assert.throws(() => validatePullRequest({...pr,head:'dev',base:'staging',sameRepository:false}));
});
