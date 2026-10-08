import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_BOT_ID, reviewCompleted, requestJson } from './codex-review.mjs';
const head = '1234567890abcdef1234567890abcdef12345678';
function summary(status = '✅ **Completed**', sha = head.slice(0, 7)) {
  return { id: 1, user: { id: CODEX_BOT_ID, type: 'Bot' },
    body: '<!-- codex-pull-request-review-summary -->\n| 📝 **Code Review** | ' + status + ' | `' + sha + '` | PR opened |' };
}
test('accepts completed review only for the current commit and trusted bot', () => {
  assert.equal(reviewCompleted([summary()], [], head, head), true);
  assert.equal(reviewCompleted([summary('✅ **Completed**', head, head)], [], head, head), true);
  assert.equal(reviewCompleted([], [], head, head), false);
  for (const status of ['⏳ **Running**', '❌ **Failed**', '**Completed**']) {
    assert.equal(reviewCompleted([summary(status)], [], head, head), false);
  }
  assert.equal(reviewCompleted([summary(undefined, 'abcdef0')], [], head, head), false);
  assert.equal(reviewCompleted([{ ...summary(), user: { id: 42, type: 'Bot' } }], [], head, head), false);
  assert.equal(reviewCompleted([{ ...summary(), user: { id: CODEX_BOT_ID, type: 'User' } }], [], head, head), false);
});
test('does not mistake security review or an older summary for the latest code review', () => {
  assert.equal(reviewCompleted([{ ...summary(), body: summary().body.replace('Code Review', 'Security Review') }], [], head, head), false);
  assert.equal(reviewCompleted([summary(), { ...summary('⏳ **Running**'), id: 2 }], [], head, head), false);
});
test('blocks changes requested for the same commit', () => {
  const review = { user: { id: CODEX_BOT_ID }, commit_id: head, state: 'CHANGES_REQUESTED' };
  assert.equal(reviewCompleted([summary()], [review], head, head), false);
  assert.equal(reviewCompleted([summary()], [{ ...review, commit_id: 'old' }], head, head), true);
});

test('does not accept a different full commit with a colliding abbreviated SHA', () => {
  const other = head.slice(0, 7) + 'a'.repeat(33);
  assert.equal(reviewCompleted([summary()], [], head, other), false);
  assert.equal(reviewCompleted([summary()], [], head), false);
});
test('retries transient HTTP failures and network timeouts with bounded attempts', async () => {
  let attempts = 0;
  const pauses = [];
  const value = await requestJson('https://example.test', 'synthetic', async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    return attempts === 2 ? new Response(null, { status: 503 }) : Response.json({ sha: head });
  }, async ms => { pauses.push(ms); });
  assert.equal(value.sha, head);
  assert.deepEqual(pauses, [500, 1000]);
  attempts = 0;
  await assert.rejects(requestJson('https://example.test', 'synthetic', async () => {
    attempts++;
    return new Response(null, { status: 502 });
  }, async () => {}), /502/);
  assert.equal(attempts, 3);
});
test('configuration and ambiguous commit errors are fatal without retry', async () => {
  for (const status of [401, 403, 404, 422]) {
    let attempts = 0;
    await assert.rejects(requestJson('https://example.test', 'synthetic', async () => {
      attempts++;
      return new Response(null, { status });
    }, async () => {}), new RegExp(String(status)));
    assert.equal(attempts, 1);
  }
});

test('respects rate limit headers for 403/429 and the original deadline', async () => {
  for (const status of [403, 429]) {
    let attempts = 0;
    const pauses = [];
    const value = await requestJson('https://example.test', 'synthetic', async () => {
      attempts++;
      return attempts === 1 ? new Response(null, { status, headers: { 'retry-after': '3' } }) : Response.json({ ok: true });
    }, async ms => { pauses.push(ms); });
    assert.equal(value.ok, true);
    assert.deepEqual(pauses, [3000]);
  }
  await assert.rejects(requestJson('https://example.test', 'synthetic', async () =>
    new Response(null, { status: 403, headers: { 'retry-after': '30' } }), async () => {}, Date.now()+1000), /deadline/);
  let attempts = 0;
  const pauses = [];
  await requestJson('https://example.test', 'synthetic', async () => {
    attempts++;
    return attempts === 1 ? new Response(null, { status:403, headers: { 'x-ratelimit-remaining':'0', 'x-ratelimit-reset':String(Math.ceil(Date.now()/1000)+2) } }) : Response.json({});
  }, async ms => { pauses.push(ms); });
  assert.equal(attempts, 2);
  assert.ok(pauses[0] > 1000 && pauses[0] <= 4000);
});

test('retries interrupted 2xx JSON bodies and secondary limits without retry headers', async () => {
  let attempts = 0;
  const pauses = [];
  const value = await requestJson('https://example.test', 'synthetic', async () => {
    attempts++;
    if (attempts === 1) return {ok:true,json:async () => {throw new TypeError('body interrupted');}};
    return Response.json({ok:true});
  }, async ms => { pauses.push(ms); });
  assert.equal(value.ok,true);
  assert.deepEqual(pauses,[500]);
  attempts=0;
  pauses.length=0;
  await requestJson('https://example.test','synthetic',async () => {
    attempts++;
    return attempts===1 ? Response.json({message:'You have exceeded a secondary rate limit.'},{status:403,headers:{'x-ratelimit-remaining':'100'}}) : Response.json({});
  },async ms => {pauses.push(ms);});
  assert.deepEqual(pauses,[60000]);
  await assert.rejects(requestJson('https://example.test','synthetic',async () =>
    Response.json({message:'Resource not accessible by integration'},{status:403}),async () => {throw Error('must not retry');}),/403/);
});
