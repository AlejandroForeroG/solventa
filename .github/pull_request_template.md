## Change

Describe the problem and final behavior in English.

## Technical acceptance criteria for this increment

State whether criteria come from a consulted Jira story/subtasks, user-approved scope or an unavailable source. Include only sanitized, self-contained technical expectations; keep private ticket links and traceability in Jira/internal context. The GitHub reviewer does not inherit Jira access or the local conversation.

| Criterion | Expected behavior | Code/documentation | Executed evidence and SHA | State and limit |
|---|---|---|---|---|
| C1 | Observable expectation for this increment | Linked file or guide | Actual run; pending if unavailable | Covered, outside this increment or blocked |

Explain excluded scope and blockers. Do not claim a finished story merely because CI or review is green. Follow [change review](../docs/change-review.md).

## Documentation

Link guides created or updated using GitHub URLs on this branch. If an internal fix has no documentation impact, explain why; every feature must be documented.

## Validation

State executed checks, results and remaining limits. When functionality changes, update its unit tests and retain relevant regressions.

Link available Codex review and explain how findings were resolved. Confirm passing CI and resolution of every review conversation. If a finding needs a user decision, wait for it before integration. GitHub enforces conversation resolution natively; no separate Codex status is required.

## Candidate

For staging: link the base branch, its `-dev` branch and the successful dev deployment containing that revision. For prod: link the successful deployment of the staging candidate. Declare migrations or configuration required before integration.
