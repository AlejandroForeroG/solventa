import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateBranch } from './git-policy.mjs';

const shaPattern = /^[a-f0-9]{40}$/;

function matchesDeployment(promotion, sha) {
  if (!shaPattern.test(sha)) return false;
  if (promotion.base === 'prod') return sha === promotion.sourceSha;
  const trialSha = promotion.deploymentTrial(sha);
  return shaPattern.test(trialSha ?? '') && promotion.isAncestor(promotion.sourceSha, trialSha)
    && promotion.sameTree(trialSha, sha);
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

export function verifyPromotion({ base, head, sourceSha, mergeSha, deployedShas, sameTree, isAncestor, deploymentTrial, isolatedCandidate }) {
  if (!shaPattern.test(sourceSha) || !shaPattern.test(mergeSha)) throw Error('Invalid promotion revision');
  if (!sameTree(sourceSha, mergeSha)) throw Error('The merge changes the candidate: update the base from staging and validate it again in dev.');
  if (base === 'prod') {
    if (head !== 'staging') throw Error('Prod only accepts releases from staging.');
    if (!deployedShas.includes(sourceSha)) throw Error('The candidate has no successful staging deployment.');
    return;
  }
  if (base !== 'staging') throw Error('Unsupported promotion target');
  validateBranch(head);
  if (!isolatedCandidate(sourceSha)) throw Error('The candidate contains unreleased dev history: promote the isolated candidate instead of its integration branch.');
  if (!deployedShas.some(sha => matchesDeployment({ base, sourceSha, sameTree, isAncestor, deploymentTrial }, sha))) {
    throw Error('The base candidate has no successful dev deployment preserving its tested integration tree.');
  }
}

export function gitChecks(cwd = process.cwd(), baselineSha, developmentRef = 'origin/dev') {
  const succeeds = args => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw Error('Cannot check the candidate Git history.');
  };
  const checks = {
    sameTree: (a, b) => succeeds(['diff', '--quiet', a, b, '--']),
    isAncestor: (a, b) => succeeds(['merge-base', '--is-ancestor', a, b]),
    isolatedCandidate: source => {
      if (!shaPattern.test(baselineSha ?? '')) throw Error('Invalid candidate baseline');
      const developmentHistory = execFileSync('git', ['rev-list', '--first-parent', developmentRef, '--not', baselineSha], { cwd, encoding: 'utf8', windowsHide: true }).trim().split(/\s+/).filter(Boolean);
      return !developmentHistory.some(revision => checks.isAncestor(revision, source) && !checks.sameTree(revision, baselineSha));
    },
    deploymentTrial: sha => {
      if (!shaPattern.test(sha ?? '')) return undefined;
      const objectType = execFileSync('git', ['cat-file', '--batch-check=%(objecttype)'], { cwd, input: `${sha}\n`, encoding: 'utf8', windowsHide: true }).trim();
      if (objectType !== 'commit') return undefined;
      const parents = execFileSync('git', ['show', '-s', '--format=%P', sha], { cwd, encoding: 'utf8', windowsHide: true }).trim().split(' ');
      return parents.length === 2 && parents.every(parent => shaPattern.test(parent)) ? parents[1] : undefined;
    },
  };
  return checks;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { TARGET_BRANCH: base, SOURCE_BRANCH: head, SOURCE_SHA: sourceSha, BASELINE_SHA: baselineSha, REPOSITORY: repository } = process.env;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !['staging', 'prod'].includes(base)) throw Error('Invalid promotion context');
    if (base === 'staging') {
      validateBranch(head);
      if (!shaPattern.test(baselineSha ?? '')) throw Error('Invalid candidate baseline');
    }
    const mergeSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
    const upstream = base === 'staging' ? 'dev' : 'staging';
    const promotion = { base, head, sourceSha, mergeSha, ...gitChecks(process.cwd(), baselineSha) };
    const deployedSha = findDeployedSha(page => JSON.parse(execFileSync('gh', [
      'api', `repos/${repository}/actions/workflows/deploy.yml/runs?event=push&branch=${upstream}&per_page=100&page=${page}`,
      '--jq', '{count: (.workflow_runs | length), candidates: [.workflow_runs[] | select(.conclusion == "success") | .head_sha]}',
    ], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024, timeout: 30_000 })), sha => matchesDeployment(promotion, sha));
    verifyPromotion({ ...promotion, deployedShas: deployedSha ? [deployedSha] : [] });
    console.log(JSON.stringify({ target: base, candidate: sourceSha, upstream, deployment: deployedSha, testedIntegration: base === 'staging' ? promotion.deploymentTrial(deployedSha) : undefined, status: 'passed' }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
