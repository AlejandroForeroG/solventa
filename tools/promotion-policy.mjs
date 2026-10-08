import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateBranch } from './git-policy.mjs';

const shaPattern = /^[a-f0-9]{40}$/;

function matchesDeployment(promotion, sha) {
  return shaPattern.test(sha) && (promotion.base === 'prod'
    ? sha === promotion.sourceSha
    : promotion.isAncestor(promotion.trialSha, sha) && promotion.sameTree(promotion.trialSha, sha));
}

export function findDeployedSha(fetchPage, accepts) {
  for (let page = 1; ; page++) {
    const { count, candidates } = fetchPage(page);
    if (!Number.isInteger(count) || count < 0 || count > 100 || !Array.isArray(candidates)
      || candidates.length > count || candidates.some(sha => !shaPattern.test(sha))) {
      throw Error('Invalid deployment page');
    }
    const match = candidates.find(accepts);
    if (match) return match;
    if (count < 100) return undefined;
  }
}

export function verifyPromotion({ base, head, sourceSha, mergeSha, trialSha, deployedShas, sameTree, isAncestor }) {
  if (!shaPattern.test(sourceSha) || !shaPattern.test(mergeSha)) throw Error('Invalid promotion revision');
  if (!sameTree(sourceSha, mergeSha)) throw Error('El merge cambia el candidato: actualiza la rama base desde staging y vuelve a validarla en dev.');
  if (base === 'prod') {
    if (head !== 'staging') throw Error('Prod solo recibe releases desde staging.');
    if (!deployedShas.includes(sourceSha)) throw Error('El candidato no tiene Deploy exitoso en staging.');
    return;
  }
  if (base !== 'staging') throw Error('Unsupported promotion target');
  validateBranch(head);
  if (head.endsWith('-dev')) throw Error('Staging requiere la rama base.');
  if (!shaPattern.test(trialSha ?? '')) throw Error('Falta la rama de integración correspondiente con sufijo -dev.');
  if (!isAncestor(sourceSha, trialSha)) throw Error('La rama -dev no contiene el candidato base actual. Sincronízala y vuelve a probar en dev.');
  if (!deployedShas.some(sha => matchesDeployment({ base, sourceSha, trialSha, sameTree, isAncestor }, sha))) {
    throw Error('La revisión actual de la rama -dev no está incluida con su mismo contenido en un Deploy exitoso de dev.');
  }
}

export function gitChecks(cwd = process.cwd()) {
  const succeeds = args => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw Error('No se pudo comprobar el historial Git del candidato.');
  };
  return {
    sameTree: (a, b) => succeeds(['diff', '--quiet', a, b, '--']),
    isAncestor: (a, b) => succeeds(['merge-base', '--is-ancestor', a, b]),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { TARGET_BRANCH: base, SOURCE_BRANCH: head, SOURCE_SHA: sourceSha, REPOSITORY: repository } = process.env;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !['staging', 'prod'].includes(base)) throw Error('Invalid promotion context');
    if (base === 'staging') validateBranch(head);
    const mergeSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
    const trialSha = base === 'staging' ? execFileSync('git', ['rev-parse', '--verify', `refs/remotes/origin/${head}-dev`], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim() : undefined;
    const upstream = base === 'staging' ? 'dev' : 'staging';
    const promotion = { base, head, sourceSha, mergeSha, trialSha, ...gitChecks() };
    const deployedSha = findDeployedSha(page => JSON.parse(execFileSync('gh', [
      'api', `repos/${repository}/actions/workflows/deploy.yml/runs?event=push&branch=${upstream}&per_page=100&page=${page}`,
      '--jq', '{count: (.workflow_runs | length), candidates: [.workflow_runs[] | select(.conclusion == "success") | .head_sha]}',
    ], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024, timeout: 30_000 })), sha => matchesDeployment(promotion, sha));
    verifyPromotion({ ...promotion, deployedShas: deployedSha ? [deployedSha] : [] });
    console.log(JSON.stringify({ target: base, candidate: sourceSha, upstream, status: 'passed' }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
