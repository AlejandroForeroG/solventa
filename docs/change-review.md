# Reviewing changes against acceptance criteria

Jira holds the operational source for stories and subtasks. The repository holds code, contracts, tests and current technical documentation. This guide supports local increment/PR review without moving backlog, planning, owners, academic documents or indiscriminate private content into the product.

## Preparing scope before implementation or review

1. Read the complete story, acceptance criteria and relevant subtasks through an authorized source. Do not infer criteria from a title or branch name. Also read architecture, contracts and affected module guides.
2. Identify the increment: behavior delivered by this PR, affected consumers/dependencies and excluded scope. Break broad criteria into observable technical checks without changing the story's intent.
3. If ticket access is unavailable, disclose the missing source and criteria that could not be checked. Never claim Jira compliance or invent a story. A task without an identified ticket can use explicitly user-approved technical scope, identified as that source; ask about any indispensable missing decision before implementing dependent behavior.
4. Keep traceability from each check to its original criterion/subtask in Jira or internal parent-repository notes, along with PR URL, reviewed SHA and consultation date. If a criterion changes during implementation, reread it and update scope, code, tests and review summary.

Reading does not authorize changing Jira statuses, owners, commitments or criteria.

## Giving the GitHub reviewer actual context

The automatic reviewer does not inherit a local conversation or a Jira connector available in another chat. An instruction to consult Jira or an inaccessible private link does not supply criteria. Before requesting review, fill the [PR template](../.github/pull_request_template.md) with a self-contained, sanitized technical brief in English:

- Identify the criterion source: consulted story/subtasks, user-approved scope or unavailable source. Do not publish private ticket keys/links, credentials, PII, partner data, conversations, owners or schedules.
- Express observable expectations for the increment with local identifiers such as C1/C2. Include contracts, errors, authorization or limits needed to judge the change; do not copy the complete story or planning.
- Map each criterion to files/guides accessible in the PR and evidence actually executed on an identified revision. A private reference is not evidence available to the reviewer.
- Explain excluded scope and remaining blockers. If technical content cannot be shared safely, retain it in authorized context and disclose that GitHub review cannot check that criterion. Never claim the gate validated it.

Example format, representing neither a real story nor executed results:

| Criterion | Technical expectation | Required review | Initial state |
|---|---|---|---|
| C1 | An unauthorized request neither persists a decision nor calls the provider | Handler, use case and rejection test with in-memory dependencies | Not executed |
| C2 | Quote and capture commit together; failure never returns success | SQL adapter/transaction and real rollback test | Not executed |
| C3 | A retired version returns 410 without invoking the backend | Gate and routing test | Not executed |

Update PR text before review; do not save criterion copies per branch in docs. Document permanent technical behavior in the existing module guide. The PR summarizes the increment and links that guide.

## Reviewing code and evidence

Apply [AGENTS Code Review Rules](../AGENTS.md#code-review-rules). Local review uses the original authorized source and increment summary. GitHub review uses the final diff, applicable rules and the technical brief actually visible; it must not invent Jira access.

For each applicable criterion, follow the complete flow and check the expected behavior: channel/route, adapter, use case, domain, persistence, provider/consumer and response, as applicable. Review relevant authorization/consent, decision history, compatibility, data ownership and failure guarantees. Validate relevant cases with [purposeful tests](testing.md).

Record per criterion:

| State | Meaning |
|---|---|
| Covered | Implementation and executed evidence suffice for that check/layer; state SHA, test/run and limits |
| Outside this increment | Not delivered in this PR; retain it as pending in the operational source without claiming compliance |
| Blocked | Required code, evidence, source, decision or dependency is missing for an applicable criterion; explain the blocker |

A planned test has not been executed. An in-memory repository does not establish a SQL transaction; a mobile export does not establish biometrics; smoke does not establish the complete business flow. If evidence does not correspond to the final SHA, identify what changed and revalidate affected behavior.

Resolve fixable findings within scope, update tests/documentation and request review of the final revision. If a finding is ambiguous, contradicts requirements, needs a product decision or cannot be resolved, explain it to the user and await their response before integration. Never mark a conversation resolved without fixing it or explicitly agreeing on its treatment.

## What automation checks

CI runs programmed Git policy, architecture, contract, type, lint, build and SQL integration checks. The review gate checks that Codex completed review on the current SHA, while GitHub enforces protections/conversations. Operational details belong in [CI/CD](infrastructure/ci-cd.md).

The gate does not retrieve Jira stories or automatically compare their criteria. AGENTS and the PR brief guide explicit reviewer checks; they are not a deterministic acceptance verifier. A Completed review may contain findings and does not mean human approval, full acceptance or a finished story. Evaluate findings and evidence before integrating, and keep Jira closure decisions under their own authorization.

[OpenAI's official review-rule documentation](https://learn.chatgpt.com/docs/agent-configuration/agents-md#add-code-review-rules) specifies `## Code Review Rules` in the applicable AGENTS file. General rules therefore live at the root and this guide provides the procedure; mechanical controls remain in CI.
