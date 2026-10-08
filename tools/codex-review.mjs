import { pathToFileURL } from 'node:url';

export const CODEX_BOT_ID = 199175422;
export function reviewedSha(comments) {
  const summaries = comments.filter(comment =>
    comment.user?.id === CODEX_BOT_ID && comment.user?.type === 'Bot' &&
    comment.body?.includes('<!-- codex-pull-request-review-summary -->'));
  summaries.sort((a, b) => b.id - a.id);
  for (const row of summaries[0]?.body?.split('\n') ?? []) {
    const cells = row.split('|');
    if (cells[1]?.includes('**Code Review**') && cells[2]?.includes('✅ **Completed**')) {
      return cells[3]?.match(/`([a-f0-9]{7,40})`/)?.[1];
    }
  }
}
export function reviewCompleted(comments, reviews, head, resolvedSha) {
  const sha = reviewedSha(comments);
  const rejected = reviews.some(review => review.user?.id === CODEX_BOT_ID &&
    review.commit_id === head && review.state === 'CHANGES_REQUESTED');
  return Boolean(sha && head.startsWith(sha) && resolvedSha === head && !rejected);
}
export async function requestJson(url, token, fetcher = fetch, pause = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetcher(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return response.json();
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) {
        throw new Error(`GitHub API returned ${response.status}`);
      }
      await response.body?.cancel();
    } catch (error) {
      if (attempt === 2 || !['TypeError', 'TimeoutError'].includes(error.name)) throw error;
    }
    await pause(500 * 2 ** attempt);
  }
}
function api(path) {
  return requestJson(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${path}`, process.env.GITHUB_TOKEN);
}
async function list(path) {
  const result = [];
  for (let page = 1; ; page++) {
    const items = await api(`${path}?per_page=100&page=${page}`);
    result.push(...items);
    if (items.length < 100) return result;
  }
}
export async function waitForReview() {
  const number = process.env.PR_NUMBER;
  const head = process.env.PR_HEAD_SHA;
  if (!/^\d+$/.test(number ?? '') || !/^[a-f0-9]{40}$/.test(head ?? '') ||
      !/^[\w.-]+\/[\w.-]+$/.test(process.env.GITHUB_REPOSITORY ?? '') || !process.env.GITHUB_TOKEN) {
    throw new Error('Missing or invalid review gate configuration');
  }
  const deadline = Date.now() + 12 * 60_000;
  do {
    const pr = await api(`pulls/${number}`);
    if (pr.state !== 'open' || pr.head.sha !== head) throw new Error('PR closed or head changed; run the check for the new commit');
    const [comments, reviews] = await Promise.all([list(`issues/${number}/comments`), list(`pulls/${number}/reviews`)]);
    const sha = reviewedSha(comments);
    // GitHub rejects ambiguous abbreviated SHAs; never use prefix equality alone.
    const resolved = sha ? (await api(`commits/${sha}`)).sha : undefined;
    if (reviewCompleted(comments, reviews, head, resolved)) {
      console.log(`Codex review completed for ${head}. GitHub separately requires resolved conversations.`);
      return;
    }
    console.log(`Waiting for Codex to finish reviewing ${head}`);
    await new Promise(resolve => setTimeout(resolve, 20_000));
  } while (Date.now() < deadline);
  throw new Error('Codex did not complete this commit within 12 minutes. Request @codex review and rerun the failed check.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  waitForReview().catch(error => { console.error(error.message); process.exitCode = 1; });
}
