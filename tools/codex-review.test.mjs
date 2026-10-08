import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_BOT_ID, reviewCompleted } from './codex-review.mjs';
const head = '1234567890abcdef1234567890abcdef12345678';
function summary(status = '✅ **Completed**', sha = head.slice(0, 7)) {
  return { id: 1, user: { id: CODEX_BOT_ID, type: 'Bot' },
    body: '<!-- codex-pull-request-review-summary -->\n| 📝 **Code Review** | ' + status + ' | `' + sha + '` | PR opened |' };
}
test('accepts completed review only for the current commit and trusted bot', () => {
  assert.equal(reviewCompleted([summary()], [], head), true);
  assert.equal(reviewCompleted([summary('✅ **Completed**', head)], [], head), true);
  assert.equal(reviewCompleted([], [], head), false);
  for (const status of ['⏳ **Running**', '❌ **Failed**', '**Completed**']) {
    assert.equal(reviewCompleted([summary(status)], [], head), false);
  }
  assert.equal(reviewCompleted([summary(undefined, 'abcdef0')], [], head), false);
  assert.equal(reviewCompleted([{ ...summary(), user: { id: 42, type: 'Bot' } }], [], head), false);
  assert.equal(reviewCompleted([{ ...summary(), user: { id: CODEX_BOT_ID, type: 'User' } }], [], head), false);
});
test('does not mistake security review or an older summary for the latest code review', () => {
  assert.equal(reviewCompleted([{ ...summary(), body: summary().body.replace('Code Review', 'Security Review') }], [], head), false);
  assert.equal(reviewCompleted([summary(), { ...summary('⏳ **Running**'), id: 2 }], [], head), false);
});
test('blocks changes requested for the same commit', () => {
  const review = { user: { id: CODEX_BOT_ID }, commit_id: head, state: 'CHANGES_REQUESTED' };
  assert.equal(reviewCompleted([summary()], [review], head), false);
  assert.equal(reviewCompleted([summary()], [{ ...review, commit_id: 'old' }], head), true);
});
