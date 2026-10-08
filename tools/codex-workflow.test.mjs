import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { currentCandidate } from './ci-report.mjs';
const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/codex-review.yml', import.meta.url), 'utf8'));
test('privileged review gate uses trusted triggers and its protected environment', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['issue_comment', 'pull_request_target', 'workflow_run']);
  assert.deepEqual(workflow.on.workflow_run.workflows, ['Codex review event']);
  assert.ok(workflow.on.issue_comment.types.includes('deleted'));
  assert.ok(!workflow.jobs.review.if.includes('codex-pull-request-review-summary'));
  assert.ok(workflow.on.pull_request_target.types.includes('edited'));
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
  for (const step of workflow.jobs.review.steps.filter(step => step.run?.includes('tools/codex-status.mjs'))) {
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
  assert.match(workflow.concurrency.group, /pull_request\.head\.sha/);
  assert.match(workflow.concurrency.group, /comment\.id/);
 });

test('Codex and CI statuses target the PR test merge commit, not a shared head', () => {
  const gate = workflow.jobs.review.steps.find(step => step.id === 'gate');
  assert.equal(gate.env.PR_MERGE_SHA, '${{ steps.pr.outputs.merge }}');
  const publish = workflow.jobs.review.steps.find(step => step.name === 'Publish final status on the reviewed integration commit');
  assert.equal(publish.env.MERGE_SHA, '${{ steps.pr.outputs.merge }}');
  assert.match(publish.if, /!cancelled\(\)/);
  assert.equal(publish.run, 'node tools/codex-status.mjs');
  const ci = YAML.parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.equal(ci.jobs.report.permissions.statuses, 'write');
  assert.deepEqual(ci.jobs.report.needs, ['policy', 'validate']);
  assert.ok(ci.jobs.report.steps.some(step => step.run === 'node tools/ci-report.mjs'));
  assert.ok(ci.jobs.policy.steps.some(step => step.run === 'node tools/ci-report.mjs pending'));
  const relay = YAML.parse(readFileSync(new URL('../.github/workflows/codex-review-events.yml', import.meta.url), 'utf8'));
  assert.deepEqual(relay.permissions, {});
  assert.deepEqual(relay.on.pull_request_review.types, ['submitted', 'edited', 'dismissed']);
  assert.equal(relay.jobs.notify.steps.length, 1);
});

test('CI rejects changed policy inputs even when the commit SHAs match', () => {
  const expected = { number: 1, title: 'feat(ci): gate', head: { sha: 'a'.repeat(40), ref: 'feat/gate', repo: { full_name: 'AlejandroForeroG/solventa' } }, base: { sha: 'b'.repeat(40), ref: 'dev' } };
  const pr = { ...structuredClone(expected), state: 'open', merge_commit_sha: 'c'.repeat(40) };
  assert.equal(currentCandidate(pr, expected), true);
  for (const mutate of [p => {p.title = 'invalid';}, p => {p.head.ref = 'feat/other';}, p => {p.base.ref = 'staging';}, p => {p.head.repo.full_name = 'other/repo';}, p => {p.head.sha = 'd'.repeat(40);}, p => {p.base.sha = 'e'.repeat(40);}, p => {p.state = 'closed';}]) {
    const changed = structuredClone(pr); mutate(changed);
    assert.equal(currentCandidate(changed, expected), false);
  }
});
