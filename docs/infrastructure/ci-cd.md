# Gitflow and promotion through PRs

Every base branch starts at `origin/staging`: `feat/<description>`, `fix/<description>`, `refactor/<description>` or `test/<description>`, lowercase with hyphens and English names. A work branch may open its PR directly to dev; no `-dev` suffix is required. When dev contains unrelated changes, preserve the candidate in a separate base branch and use another valid work branch for integration. The integration name is unrestricted within the normal branch format; `feat/quotes-validation` is one example. Every branch allows at most 72 characters. Commits/PR titles: `feat|fix|refactor|test(module): description`, maximum 150 characters on the first line after trimming surrounding whitespace, in English. Surrounding spaces do not reject an otherwise valid title; type, scope and description are still required. `npm ci` activates native hooks; CI revalidates PR source, target and title.

The [complete Lucidchart diagram](https://lucid.app/lucidchart/1d00d2c4-f0fe-40a9-934b-d1cc4a2ea8e0/edit) illustrates the staging origin, base branch, optional integration branch, fixes returning to the base, dev and prod releases. Its `-dev` labels are naming examples, not a suffix requirement.

## 1. Creating and developing the base branch

```sh
git fetch origin
git switch -c feat/quotes origin/staging
```

Implement/test the feature, update existing module documentation and commit coherent changes on this base. Consult [testing](../testing.md), [endpoints](../endpoint-standards.md) and [migrations](migrations.md) as applicable. The base contains only changes intended for staging.

## 2. Validating through a dev integration branch

If dev has no unrelated changes and its merge preserves the candidate tree, open the candidate branch directly to dev. Otherwise, create a separate integration branch so that dev-only work cannot enter staging:

```sh
git switch -c feat/quotes-validation feat/quotes
git merge --no-ff -m "refactor(ci): integrate dev to test quotes" origin/dev
git push -u origin feat/quotes
git push -u origin feat/quotes-validation
```

Resolve integration conflicts in `feat/quotes-validation`. Open **`feat/quotes-validation` → `dev`** with links to guides created/updated on that branch and test results. CI checks policy, architecture, tests, lint, types, builds and local SQL/RPC with TLS. Integrate through a normal merge after green checks and resolution of all review conversations. Deploy repeats CI, publishes dev's four Workers and checks SQL/RPC/isolation. Validate the actual flow in dev.

If functionality is corrected on the separate integration branch, cherry-pick relevant commits back to the base; never copy merges or unrelated dev work:

```sh
git switch feat/quotes
git cherry-pick <fix-sha>
git push
git switch feat/quotes-validation
git merge --no-ff -m "fix(ci): synchronize the base branch correction" feat/quotes
git push
```

An integration-only resolution may remain on the separate integration branch; every fix needed by the feature must reach the base. Synchronize the base back into that integration branch: cherry-pick creates another SHA and CI checks ancestry as well as content. Open another integration-branch → dev PR and wait for successful CI/Deploy for that revision. Never merge dev into the base.

## 3. Promoting the ready base to staging

Open **`feat/quotes` → `staging`** once behavior is validated. Link candidate-branch guides and the successful dev Deploy containing the tested revision, whether it came from the candidate directly or a separate integration branch. Dev may contain other features: staging receives only this base.

The gate verifies:

- The candidate does not inherit unreleased dev history. CI examines dev's first-parent history outside the staging baseline and rejects a candidate containing any such revision whose tree differs from that baseline. Released ancestry with an identical staging tree is allowed. This rejects normal-merge integration history containing unrelated dev work, regardless of its name.
- The exact base SHA is an ancestor of the immutable integration SHA recorded as the second parent of a successful normal dev deployment merge. A direct commit, squash or octopus merge is not valid integration proof.
- The tested integration may differ from the candidate, including files changed by the candidate. The gate checks candidate ancestry rather than file-by-file equivalence. Review the differences and return feature fixes to the base when needed; a successful dev deployment does not prove identical staging behavior.
- The successful deployment preserves the integration revision's entire tree. A reverted/overwritten deployment cannot establish that validation.
- The candidate staging merge tree matches the base tree.

Proof is tied to immutable candidate, integration and deployment SHAs, not the current sibling branch tip. Later pushes or deletion of an integration branch cannot change what was deployed; a new base SHA invalidates the old proof and triggers PR checks again. Keep the candidate and any separate integration branch until promotion completes even though Git history preserves completed deployment proof. The gate reports its selected deployment and tested integration SHAs.

These checks validate Git history and deployment integrity, not candidate/integration content equivalence or the intended scope of arbitrary copied code. Squashing, cherry-picking or manually copying unrelated dev work can discard the ancestry used by the isolation check; the earlier suffix-based policy also did not detect that case. Do not squash dev into a candidate or copy unrelated dev content into it. Review candidate changes against the approved increment as well as checking CI. Normal merges preserve evidence but do not replace scope review.

Deployment lookup processes pages of at most 100 runs, retains only successful SHAs and stops when it finds a valid candidate; it does not download all history into memory. A historical deployment whose commit is absent from the checkout, or whose object is not a commit, is ineligible proof and is skipped. Git repository or command failures still stop validation. Without a valid deployment, promotion remains blocked.

If staging advances, update the base from `origin/staging` through a normal merge, resolve candidate compatibility there and synchronize any separate integration branch. Repeat tests and dev PR/Deploy before promotion; do not approve an untested combined result. The gate alone does not establish business acceptance tests.

Keep the candidate and any separate integration branch until promotion is complete. Use **normal merges** in these PRs, including work branch → dev: squash/rebase removes ancestry needed to establish deployment. Do not automatically delete a candidate or integration branch after its first dev PR. Do not use Update branch if it would bring dev into the base.

## 4. Publishing a staging release to prod

Staging Deploy reruns CI, publishes staging and validates infrastructure. Test the candidate and open **`staging` → `prod`** for each release. Link the successful Deploy of the exact staging SHA, release guides and checks. CI requires that deployment and a merge preserving the source tree. Use a normal merge and wait for successful prod Deploy.

If prod merge history needs to return to staging, use a maintenance base originating from staging and, when needed, a separate integration branch, following the same flow. Never push directly or copy all dev changes. `main` is a historical reference without deployment.

## Protections and PR documentation

All three branches require PRs, `policy` and `validate` checks from GitHub Actions, an up-to-date branch and resolved conversations; this also applies to administrators. GitHub's native **Require conversation resolution before merging** setting blocks unresolved review threads. Dev requires no human approval. Staging/prod normally require one approval. An explicitly authorized exception affects only the requested promotion: preserve CI and restore the temporary approval requirement.

Use Codex feedback and check relevant technical criteria. Follow [change review](../change-review.md) to give the reviewer accessible context, record evidence and resolve findings or consult the user. Do not mark a thread resolved merely to unblock merging. There is no separate required Codex status, custom review workflow or GitHub App; conversation resolution is enforced natively. This setting does not prove that Codex finished a review or accepted every criterion. Review does not replace CI or required human approval; it also does not establish completion of an entire story.

Use the [PR template](../../.github/pull_request_template.md). Each PR links its new/updated documents using GitHub URLs on its source branch and explains change, executed tests and limits in English. An internal fix with no documentation impact must justify it; every feature includes documentation. Do not create copies per branch/environment. Messages do not select environments: the target branch does.

## GitHub configuration

Go to **Settings > Environments** in the repository. `dev`, `staging` and `prod` exist. Configure in each:

| Type | Name | Value |
|---|---|---|
| Variable | DATABASE_HOST | CockroachDB cluster host |
| Variable | DATABASE_PORT | SQL port, normally 26257 |
| Secret | DATABASE_CA_PEM | Complete public cluster CA bundle |
| Secret | RUNTIME_STATE_JSON | Contents of infra/.local/runtime.<environment>.json |
| Secret | WEB_INFRA_TOKEN | DEV_INFRA_TOKEN from infra/.local/web.<environment>.secrets.json |
| Secret | IDENTITY_AUTH_JSON | Identity configuration held for that environment; see [authentication](../modules/identity-consent-ecosystem/authentication.md) |
| Optional secret | SECURITY_ALERT_EMAIL_CONFIG | Exact JSON with `environment`, `from` and `to` for that environment; see [security email setup](../security.md). Omission deploys an empty Worker secret and disables publication |
| Secret | CLOUDFLARE_API_TOKEN | Deployment token for the configured account |

Runtime/web values belong to the environment and must preserve provisioned credentials. Never put an administrative URL, root password or client certificates in GitHub. CD uses runtime credentials to check SQL and the Cloudflare API to publish. The account ID stays fixed in configuration.

Email configuration is validated before CI writes credential files: only the matching environment, two bounded email addresses and the exact three keys are accepted. The value is included in Identity's protected deployment secret file and is never printed. Configure it in each authorized GitHub environment after sender onboarding; normal deployment applies it. Removing it disables publication on the next successful deployment. Do not enable email by a direct secret update that bypasses the normal release flow.

Create a Cloudflare token limited to the configured account with **Workers Scripts: Edit**, **Workers Tail: Read**, **Account Settings: Read**, **Hyperdrive: Read** and **Account: SSL and Certificates: Read**. The flow needs neither Hyperdrive Edit, zone routes nor certificate-creation permission. Workers Tail Read is part of usual Wrangler publishing permissions. Workers Scripts authorization covers the account, so environment selection also depends on repository controls and verified bindings.

GitHub environment policies allow only their matching branch: dev, staging or prod. PRs receive no remote credentials; only the post-CI Deploy job restores them. Secrets are always cleaned afterward. Provision all required resources before integrating dependent changes.

The optional `FINANCIAL_EVENT_JSON` environment secret enables only the synthetic financial increment in dev/staging. Its exact shape is `{ "environment": "dev", "secrets": { "FINANCIAL_EVENT_KEY": "<64 lowercase hex characters>" } }`, replacing `dev` consistently for staging. Generate independent keys per environment and retain them in authorized custody; never reuse cookie or quote keys. Both Acquisition and Policy receive the same key within their environment. A mismatched environment, unknown field, malformed key or any production mock configuration fails restoration before writing files. An absent value restores an empty key and financial composition fails closed. Cleanup removes only the selected environment's financial secret file.

Create `solventa-financial-events-<environment>` and its `solventa-financial-events-dlq-<environment>` before deploying the corresponding Workers. Acquisition publishes accepted offers through its durable outbox and minute fallback; Policy consumes through its inbox. CI runs both owner SQL suites on an isolated synthetic database. Mock provider ledgers establish application recovery and idempotency only; they do not establish real payment settlement or a legally valid external signature. Production financial mode and queue bindings remain disabled.

An account-level Workers Scripts token can modify Workers in other environments. Branches/environments do not constrain that scope within Cloudflare: code integrated into dev receives a token potentially capable of publishing over prod. This foundation assumes trusted collaborators and has no real users. Before real data, define isolation through separate Cloudflare accounts or mandatory review of executable infrastructure/CI changes. Distinct tokens with identical account scope do not solve this limit by themselves.

## Migrations and recovery

[Migration procedures](migrations.md) are the single reference for creating SQL, validating permissions, applying approved candidates before integration and reconciling failures. CD uses only runtime roles: it checks schema before publication and never receives administrative credentials or applies remote DDL.

Deploy does not automatically roll back after a failed post-deployment check. Prepare a compatible revision through the same Gitflow and verify it before promotion. Worker rollback does not revert SQL/data; preserve migrations/checksums and follow that guide's recovery procedure.
