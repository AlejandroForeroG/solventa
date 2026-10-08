import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { requestJson } from './codex-review.mjs';
import { publishCodexStatus } from './codex-status.mjs';

export function currentCandidate(pr, expected) {
  return pr.state === 'open' && /^[a-f0-9]{40}$/.test(pr.merge_commit_sha ?? '') &&
    pr.head?.sha === expected.head?.sha && pr.base?.sha === expected.base?.sha &&
    pr.title === expected.title && pr.head?.ref === expected.head?.ref && pr.base?.ref === expected.base?.ref &&
    pr.head?.repo?.full_name === expected.head?.repo?.full_name;
}
async function report() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const expected = event.pull_request;
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !Number.isSafeInteger(expected?.number) || expected.number <= 0 || !token) throw Error('Invalid CI report configuration');
  const deadline = Date.now() + 4 * 60_000;
  const pr = await requestJson(`https://api.github.com/repos/${repository}/pulls/${expected.number}`, token, fetch, undefined, deadline);
  if (!currentCandidate(pr, expected)) throw Error('PR candidate or policy input changed; ignore this obsolete CI run');
  const pending = process.argv[2] === 'pending';
  for (const context of ['policy', 'validate']) {
    const result = context === 'policy' ? process.env.POLICY_RESULT : process.env.VALIDATE_RESULT;
    await publishCodexStatus({ repository, merge: pr.merge_commit_sha, token, context, deadline,
      state: pending ? 'pending' : result === 'success' ? 'success' : 'failure',
      description: `CI ${context} for PR #${expected.number} integration commit`,
      targetUrl: `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}` });
  }
  console.log('CI integration statuses published');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  report().catch(error => { console.error(error.message); process.exitCode = 1; });
}
