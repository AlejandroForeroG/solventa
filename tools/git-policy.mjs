import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function validateCommit(message) {
  const title = message.split(/\r?\n/)[0];
  if (title.length > 150) throw Error(`The title has ${title.length} characters; the maximum is 150. Shorten the description and move details to the commit body.`);
  if (!/^(feat|fix|refactor|test)\([a-z][a-z0-9-]*\): \S(?:.*\S)?$/.test(title)) throw Error('Use feat|fix|refactor|test(module): description. Example: fix(mobile): add welcome screen.');
}
export function validateBranch(branch) {
  if (branch.length > 72 || !/^(feat|fix|refactor|test)\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branch)) throw Error('Use feat|fix|refactor|test/<description> in lowercase with hyphens, at most 72 characters. Example: fix/expo-structure.');
}
export function validatePullRequest({ head, base, title, sameRepository }) {
  validateCommit(title);
  if (!sameRepository) throw Error('The PR must originate from this repository.');
  if (base === 'dev' || base === 'staging') {
    validateBranch(head);
    if (base === 'dev') {
      if (!head.endsWith('-dev')) throw Error('Use the -dev integration branch for dev; preserve the base branch for staging.');
      validateBranch(head.slice(0, -4));
      if (head.slice(0, -4).endsWith('-dev')) throw Error('Reserve the -dev suffix exclusively for the integration branch.');
    } else if (head.endsWith('-dev') || head.length > 68) throw Error('Use a base branch without -dev for staging; reserve four characters for its integration partner.');
  } else if (!(base === 'prod' && head === 'staging')) throw Error('Allowed flow: base → -dev → dev; base → staging; staging → prod.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mode = process.argv[2];
    if (mode === 'commit') validateCommit(readFileSync(process.argv[3], 'utf8'));
    else if (mode === 'branch') validateBranch(execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim());
    else if (mode === 'pr') {
      const { pull_request: pr, repository } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      validatePullRequest({ head: pr.head.ref, base: pr.base.ref, title: pr.title, sameRepository: pr.head.repo?.full_name === repository.full_name });
    } else throw Error('Unknown mode.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
