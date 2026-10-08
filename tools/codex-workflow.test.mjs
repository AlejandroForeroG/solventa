import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/codex-review.yml', import.meta.url), 'utf8'));
test('privileged review gate uses trusted triggers and its protected environment', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['issue_comment', 'pull_request_target']);
  assert.equal(workflow.jobs.review.environment, 'codex-review-gate');
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.permissions['pull-requests'], 'read');
  assert.equal(workflow.permissions.statuses, undefined);
  const checkout = workflow.jobs.review.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  const token = workflow.jobs.review.steps.find(step => step.id === 'app');
  assert.equal(token.with['private-key'], '${{ secrets.CODEX_GATE_PRIVATE_KEY }}');
  assert.equal(token.with['permission-statuses'], 'write');
  for (const step of workflow.jobs.review.steps.filter(step => step.run?.includes('statuses/$'))) {
    assert.equal(step.env.GH_TOKEN, '${{ steps.app.outputs.token }}');
  }
  assert.match(workflow.jobs.review.if, /author_association/);
  assert.match(workflow.jobs.review.if, /COLLABORATOR/);
  assert.match(workflow.jobs.review.if, /199175422/);
});
