import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function validateCommit(message) {
  const title = message.split(/\r?\n/)[0];
  if (title.length > 150) throw Error(`El título tiene ${title.length} caracteres; el máximo es 150. Acorta la descripción y mueve los detalles al cuerpo del commit.`);
  if (!/^(feat|fix|refactor|test)\([a-z][a-z0-9-]*\): \S(?:.*\S)?$/.test(title)) throw Error('Usa feat|fix|refactor|test(modulo): descripción. Ejemplo: fix(mobile): agregar pantalla de bienvenida.');
}
export function validateBranch(branch) {
  if (branch.length > 72 || !/^(feat|fix|refactor|test)\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branch)) throw Error('Usa feat|fix|refactor|test/<descripcion> en minúsculas, con guiones y máximo 72 caracteres. Ejemplo: fix/struct-expo.');
}
export function validatePullRequest({ head, base, title, sameRepository }) {
  validateCommit(title);
  if (!sameRepository) throw Error('El PR debe proceder de este repositorio.');
  if (base === 'dev' || base === 'staging') {
    validateBranch(head);
    if (base === 'dev') {
      if (!head.endsWith('-dev')) throw Error('Hacia dev usa la rama de integración con sufijo -dev; conserva la rama base para staging.');
      validateBranch(head.slice(0, -4));
      if (head.slice(0, -4).endsWith('-dev')) throw Error('Reserva el sufijo -dev exclusivamente para la rama de integración.');
    } else if (head.endsWith('-dev') || head.length > 68) throw Error('Hacia staging usa una rama base sin sufijo -dev y reserva cuatro caracteres para su rama de integración.');
  } else if (!(base === 'prod' && head === 'staging')) throw Error('Flujo permitido: rama base → rama -dev → dev; rama base → staging; staging → prod.');
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
