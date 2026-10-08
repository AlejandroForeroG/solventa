import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_BOT_ID, SHA_REF_PATTERN, SHA_REF_GUARDS, protectsShaRefs, reviewCompleted, requestJson } from './codex-review.mjs';
const head = '1234567890abcdef1234567890abcdef12345678';
test('requires active creation guards without bypasses or excluded refs', () => {
  for (const target of ['branch', 'tag']) {
    const pinned = SHA_REF_GUARDS.find(rule => rule.target === target);
    const guard = { id: pinned.id, updated_at: pinned.updatedAt, target, enforcement: 'active', bypass_actors: [], rules: [{ type: 'creation' }],
      conditions: { ref_name: { include: [`refs/${target === 'branch' ? 'heads' : 'tags'}/${SHA_REF_PATTERN}`], exclude: [] } } };
    assert.equal(protectsShaRefs(guard, target), true);
    assert.equal(protectsShaRefs({ ...guard, bypass_actors: undefined }, target), true);
    assert.equal(protectsShaRefs({ ...guard, updated_at: '2027-01-01T00:00:00Z', bypass_actors: undefined }, target), false);
    assert.equal(protectsShaRefs({ ...guard, id: pinned.id + 1 }, target), false);
    assert.equal(protectsShaRefs({ ...guard, enforcement: 'disabled' }, target), false);
    assert.equal(protectsShaRefs({ ...guard, bypass_actors: [{ actor_id: 5 }] }, target), false);
    assert.equal(protectsShaRefs({ ...guard, conditions: { ref_name: { ...guard.conditions.ref_name, exclude: ['refs/heads/1234567'] } } }, target), false);
    assert.equal(protectsShaRefs({ ...guard, rules: [] }, target), false);
  }
});
function summary(status = '✅ **Completed**', sha = head.slice(0, 7)) {
  return { id: 1, user: { id: CODEX_BOT_ID, type: 'Bot' }, lastEditedAt: null,
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
test('rejects a bot summary edited by a collaborator or without editorial evidence', () => {
  const edited = { ...summary(), lastEditedAt: '2026-10-08T00:00:00Z' };
  assert.equal(reviewCompleted([edited], [], head, head), false);
  assert.equal(reviewCompleted([{ ...edited, editor: { id: 42, type: 'User' } }], [], head, head), false);
  assert.equal(reviewCompleted([{ ...edited, editor: { id: CODEX_BOT_ID, type: 'Bot' } }], [], head, head), true);
  assert.equal(reviewCompleted([{ ...summary(), lastEditedAt: undefined }], [], head, head), false);
});
test('removing a marker cannot hide an edited bot comment behind an older summary', () => {
  const tampered = { ...summary(), id: 2, body: 'Marker removed', lastEditedAt: '2026-10-08T00:00:00Z', editor: { id: 42, type: 'User' } };
  assert.equal(reviewCompleted([summary(), tampered], [], head, head), false);
  assert.equal(reviewCompleted([summary(), { ...summary(), id: 2, body: 'Official non-summary comment' }], [], head, head), true);
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

test('retries truncated JSON responses within the same attempt and deadline limits', async () => {
  let attempts = 0;
  const value = await requestJson('https://example.test', 'synthetic', async () =>
    ++attempts === 1 ? new Response('{"sha":') : Response.json({ sha: head }), async () => {});
  assert.equal(value.sha, head);
  assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(requestJson('https://example.test', 'synthetic', async () => {
    attempts++;
    return new Response('{');
  }, async () => {}), SyntaxError);
  assert.equal(attempts, 3);
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
test('retries GraphQL rate limits carried by HTTP 200, but not query or permission errors', async () => {
  for (const error of [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }, { message: 'You have exceeded a secondary rate limit' }]) {
    let attempts = 0;
    const pauses = [];
    const value = await requestJson('https://api.github.com/graphql', 'synthetic', async () => {
      attempts++;
      return Response.json(attempts === 1 ? { errors: [error] } : { data: { nodes: [] } });
    }, async ms => { pauses.push(ms); });
    assert.equal(attempts, 2);
    assert.deepEqual(pauses, [60_000]);
    assert.deepEqual(value.data.nodes, []);
  }
  let attempts = 0;
  const value = await requestJson('https://api.github.com/graphql', 'synthetic', async () => {
    attempts++;
    return Response.json({ errors: [{ type: 'FORBIDDEN', message: 'Access denied' }] });
  }, async () => {});
  assert.equal(attempts, 1);
  assert.equal(value.errors[0].type, 'FORBIDDEN');
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
import { publishCodexStatus } from './codex-status.mjs';

test('status publication reconciles an uncertain write before retrying', async () => {
  const config = { repository: 'AlejandroForeroG/solventa', merge: 'a'.repeat(40), token: 'test-token',
    state: 'success', description: 'Reviewed', targetUrl: 'https://github.com/AlejandroForeroG/solventa/actions/runs/1' };
  let writes = 0;
  let reads = 0;
  const result = await publishCodexStatus(config, async (url, options) => {
    if (options.method === 'POST') { writes++; throw new TypeError('Connection interrupted after write'); }
    reads++;
    assert.match(url, /\/commits\/[a-f0-9]{40}\/statuses/);
    return new Response(JSON.stringify([{ context: 'codex-review', state: config.state, description: config.description,
      target_url: config.targetUrl, creator: { login: 'solventa-codex-review-gate[bot]' } }]), { status: 200 });
  }, async () => {});
  assert.equal(result.state, 'success');
  assert.equal(writes, 1);
  assert.equal(reads, 1);
});

test('status publication retries a transient failure but not a permission denial', async () => {
  const config = { repository: 'AlejandroForeroG/solventa', merge: 'b'.repeat(40), token: 'test-token',
    state: 'pending', description: 'Waiting', targetUrl: 'https://github.com/AlejandroForeroG/solventa/actions/runs/2' };
  let writes = 0;
  await publishCodexStatus(config, async (_url, options) => {
    if (options.method !== 'POST') return new Response('[]');
    return ++writes === 1 ? new Response('{}', { status: 503 }) : new Response('{"state":"pending"}');
  }, async () => {});
  assert.equal(writes, 2);
  writes = 0;
  await assert.rejects(() => publishCodexStatus(config, async () => { writes++; return new Response('{"message":"Forbidden"}', { status: 403 }); }, async () => {}), /403/);
  assert.equal(writes, 1);
});
