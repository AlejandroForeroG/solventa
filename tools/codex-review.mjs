import { pathToFileURL } from 'node:url';

export const CODEX_BOT_ID = 199175422;
export function reviewedSha(comments) {
  const botComments = comments.filter(comment => comment.user?.id === CODEX_BOT_ID && comment.user?.type === 'Bot');
  // Check editorial identity before content: removing a marker cannot hide tampering.
  if (botComments.some(comment => !(comment.lastEditedAt === null ||
      (typeof comment.lastEditedAt === 'string' && comment.editor?.type === 'Bot' && comment.editor.id === CODEX_BOT_ID)))) return;
  const summaries = botComments.filter(comment => comment.body?.includes('<!-- codex-pull-request-review-summary -->'));
  summaries.sort((a, b) => b.id - a.id);
  const summary = summaries[0];
  if (!summary) return;
  for (const row of summary.body?.split('\n') ?? []) {
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
export async function requestJson(url, token, fetcher = fetch, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), deadline = Date.now() + 12 * 60_000, request = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let delay = 500 * 2 ** attempt;
    if (Date.now() >= deadline) throw new Error('GitHub API deadline exceeded');
    try {
      const response = await fetcher(url, {
        ...request,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(Math.min(30_000, deadline - Date.now())),
      });
      let limited = false;
      if (response.ok) {
        const payload = await response.json();
        limited = url === 'https://api.github.com/graphql' && Array.isArray(payload.errors) && payload.errors.length > 0 &&
          payload.errors.every(error => error?.type === 'RATE_LIMITED' ||
            (typeof error?.message === 'string' && /secondary rate limit|API rate limit exceeded/i.test(error.message)));
        if (!limited) return payload;
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      limited ||= response.status === 429 || (response.status === 403 &&
        (retryAfter > 0 || response.headers.get('x-ratelimit-remaining') === '0'));
      if (response.status === 403 && !limited) {
        const payload = await response.json().catch(error => {
          if (error.name === 'SyntaxError') return {};
          throw error;
        });
        limited = typeof payload.message === 'string' && /secondary rate limit/i.test(payload.message);
      }
      const transient = limited || [500, 502, 503, 504].includes(response.status);
      if (!response.bodyUsed) await response.body?.cancel();
      if (!transient || attempt === 2) throw new Error(response.ok && limited ? 'GitHub GraphQL rate limit persists' : `GitHub API returned ${response.status}`);
      if (limited) {
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000 - Date.now();
        delay = retryAfter > 0 ? retryAfter * 1000 : reset > 0 ? reset + 1000 : 60_000;
      }
    } catch (error) {
      if (attempt === 2 || !['TypeError', 'TimeoutError'].includes(error.name)) throw error;
    }
    if (delay >= deadline - Date.now()) throw new Error('GitHub rate limit or retry exceeds review deadline');
    await pause(delay);
  }
}
let reviewDeadline;
function api(path) {
  return requestJson(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${path}`, process.env.GITHUB_TOKEN, fetch, undefined, reviewDeadline);
}
async function list(path) {
  const result = [];
  for (let page = 1; ; page++) {
    const items = await api(`${path}?per_page=100&page=${page}`);
    result.push(...items);
    if (items.length < 100) return result;
  }
}
async function verifiedSummary(comments) {
  const bots = comments.filter(comment => comment.user?.id === CODEX_BOT_ID && comment.user?.type === 'Bot');
  const verified = [];
  for (let offset = 0; offset < bots.length; offset += 100) {
    const ids = bots.slice(offset, offset + 100).map(comment => comment.node_id);
    const result = await requestJson('https://api.github.com/graphql', process.env.GITHUB_TOKEN, fetch, undefined, reviewDeadline,
      { method: 'POST', body: JSON.stringify({ query: 'query($ids:[ID!]!){nodes(ids:$ids){... on IssueComment{databaseId body lastEditedAt author{__typename ... on Bot{databaseId}} editor{__typename ... on Bot{databaseId}}}}}', variables: { ids } }) });
    if (result.errors || !Array.isArray(result.data?.nodes) || result.data.nodes.length !== ids.length || result.data.nodes.some(node => !node)) throw Error('Cannot verify bot comment editors');
    for (const node of result.data.nodes) {
      verified.push({ id: node.databaseId, body: node.body, lastEditedAt: node.lastEditedAt,
        user: { id: node.author?.databaseId, type: node.author?.__typename },
        editor: { id: node.editor?.databaseId, type: node.editor?.__typename } });
    }
  }
  return verified;
}
export async function waitForReview() {
  const number = process.env.PR_NUMBER;
  const head = process.env.PR_HEAD_SHA;
  const merge = process.env.PR_MERGE_SHA;
  if (!/^\d+$/.test(number ?? '') || !/^[a-f0-9]{40}$/.test(head ?? '') ||
      !/^[\w.-]+\/[\w.-]+$/.test(process.env.GITHUB_REPOSITORY ?? '') || !process.env.GITHUB_TOKEN || (merge && !/^[a-f0-9]{40}$/.test(merge))) {
    throw new Error('Missing or invalid review gate configuration');
  }
  const deadline = Date.now() + 12 * 60_000;
  reviewDeadline = deadline;
  do {
    const pr = await api(`pulls/${number}`);
    if (pr.state !== 'open' || pr.head.sha !== head || (merge && pr.merge_commit_sha !== merge)) throw new Error('PR closed or head changed; run the check for the new commit');
    const [rawComments, reviews] = await Promise.all([list(`issues/${number}/comments`), list(`pulls/${number}/reviews`)]);
    const comments = await verifiedSummary(rawComments);
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
