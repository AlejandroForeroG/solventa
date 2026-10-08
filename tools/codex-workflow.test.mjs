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
  assert.equal(checkout.with.ref, '${{ github.event.repository.default_branch }}');
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

 test('ignored comments cannot cancel an authorized run', () => {
  assert.match(workflow.concurrency.group, /github\.run_id/);
  assert.match(workflow.concurrency.group, /author_association/);
  assert.match(workflow.concurrency.group, /199175422/);
 });

test('Codex and CI statuses target the PR test merge commit, not a shared head', () => {
  const gate = workflow.jobs.review.steps.find(step => step.id === 'gate');
  assert.equal(gate.env.PR_MERGE_SHA, '${{ steps.pr.outputs.merge }}');
  const publish = workflow.jobs.review.steps.find(step => step.name === 'Publish final status on the reviewed integration commit');
  assert.equal(publish.env.MERGE_SHA, '${{ steps.pr.outputs.merge }}');
  assert.match(publish.run, /statuses\/\$MERGE_SHA/);
  const ci = YAML.parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.equal(ci.jobs.report.permissions.statuses, 'write');
  assert.deepEqual(ci.jobs.report.needs, ['policy', 'validate']);
  assert.match(ci.jobs.report.steps[0].run, /merge_commit_sha/);
  assert.match(ci.jobs.report.steps[0].run, /BASE_SHA/);
  assert.match(ci.jobs.report.steps[0].run, /state=failure/);
});
