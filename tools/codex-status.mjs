import { pathToFileURL } from 'node:url';
import { requestJson } from './codex-review.mjs';

export async function publishCodexStatus({ repository, merge, token, state, description, targetUrl }, fetcher = fetch, pause) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^[a-f0-9]{40}$/.test(merge ?? '') ||
      !token || !['pending', 'success', 'failure'].includes(state) || typeof description !== 'string' || description.length > 140 ||
      !targetUrl?.startsWith(`https://github.com/${repository}/actions/runs/`)) throw Error('Invalid status configuration');
  const base = `https://api.github.com/repos/${repository}`;
  const body = { state, context: 'codex-review', description, target_url: targetUrl };
  const deadline = Date.now() + 2 * 60_000;
  let attempt = 0;
  // A status is an idempotent assertion. Check an uncertain write before repeating it.
  const reconcileAndWrite = async (url, options) => {
    if (attempt++ > 0) {
      const statuses = await requestJson(`${base}/commits/${merge}/statuses?per_page=100`, token, fetcher, pause, deadline);
      const latest = statuses.find(status => status.context === body.context);
      if (latest?.creator?.login === 'solventa-codex-review-gate[bot]' && latest.state === state &&
          latest.description === description && latest.target_url === targetUrl) {
        return new Response(JSON.stringify(latest), { status: 200 });
      }
    }
    return fetcher(url, options);
  };
  return requestJson(`${base}/statuses/${merge}`, token, reconcileAndWrite, pause, deadline, { method: 'POST', body: JSON.stringify(body) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  publishCodexStatus({ repository: process.env.GITHUB_REPOSITORY, merge: process.env.MERGE_SHA,
    token: process.env.GH_TOKEN, state: process.env.STATUS_STATE, description: process.env.STATUS_DESCRIPTION,
    targetUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  }).then(() => console.log('Codex integration status published')).catch(error => { console.error(error.message); process.exitCode = 1; });
}
