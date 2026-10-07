import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function validateCommit(message) {
  const title = message.split(/\r?\n/)[0];
  if (title.length > 72) throw Error(`El título tiene ${title.length} caracteres; el máximo es 72. Acorta la descripción y mueve los detalles al cuerpo del commit.`);
  if (!/^(feat|fix|refactor|test)\([a-z][a-z0-9-]*\): \S(?:.*\S)?$/.test(title)) throw Error('Usa feat|fix|refactor|test(modulo): descripción. Ejemplo: fix(mobile): agregar pantalla de bienvenida.');
}
export function validateBranch(branch) {
  if (branch.length > 72 || !/^(feat|fix|refactor|test)\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branch)) throw Error('Usa feat|fix|refactor|test/<descripcion> en minúsculas, con guiones y máximo 72 caracteres. Ejemplo: fix/struct-expo.');
}
export function validatePullRequest({ head, base, title, sameRepository }) {
  validateCommit(title);
  if (!sameRepository) throw Error('El PR debe proceder de este repositorio.');
  if (base === 'dev') validateBranch(head);
  else if (!((base === 'staging' && head === 'dev') || (base === 'prod' && head === 'staging'))) throw Error('Flujo permitido: feat|fix|refactor|test/* → dev → staging → prod.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mode = process.argv[2];
    if (mode === 'commit') validateCommit(readFileSync(process.argv[3], 'utf8'));
    else if (mode === 'branch') validateBranch(execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim());
    else if (mode === 'pr') {
      const { pull_request: pr, repository } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      validatePullRequest({ head: pr.head.ref, base: pr.base.ref, title: pr.title, sameRepository: pr.head.repo?.full_name === repository.full_name });
    } else throw Error('Modo desconocido.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
