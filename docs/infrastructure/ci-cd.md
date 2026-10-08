# Gitflow and promotion through PRs

Every base branch starts at `origin/staging`: `feat/<description>`, `fix/<description>`, `refactor/<description>` or `test/<description>`, lowercase with hyphens and English names. Create its partner with the same name plus `-dev`, for example `feat/quotes-dev`. Every branch allows at most 72 characters; reserve four for the suffix (base at most 68). Commits/PR titles: `feat|fix|refactor|test(module): description`, maximum 150 characters on the first line, in English. `npm ci` activates native hooks; CI revalidates PR source, target and title.

The [complete Lucidchart diagram](https://lucid.app/lucidchart/1d00d2c4-f0fe-40a9-934b-d1cc4a2ea8e0/edit) shows the staging origin, base branch, integration partner, fixes returning to the base, dev and prod releases.

## 1. Creating and developing the base branch

```sh
git fetch origin
git switch -c feat/quotes origin/staging
```

Implement/test the feature, update existing module documentation and commit coherent changes on this base. Consult [testing](../testing.md), [endpoints](../endpoint-standards.md) and [migrations](migrations.md) as applicable. The base contains only changes intended for staging.

## 2. Validating through a dev integration branch

Once changes are on the base:

```sh
git switch -c feat/quotes-dev feat/quotes
git merge --no-ff -m "refactor(ci): integrate dev to test quotes" origin/dev
git push -u origin feat/quotes
git push -u origin feat/quotes-dev
```

Resolve integration conflicts in `feat/quotes-dev`. Open **`feat/quotes-dev` → `dev`** with links to guides created/updated on that branch and test results. CI checks policy, architecture, tests, lint, types, builds and local SQL/RPC with TLS. Integrate through a normal merge after green checks and completed current-head Codex review. Deploy repeats CI, publishes dev's four Workers and checks SQL/RPC/isolation. Validate the actual flow in dev.

If functionality is corrected on `-dev`, cherry-pick relevant commits back to the base; never copy merges or unrelated dev work:

```sh
git switch feat/quotes
git cherry-pick <fix-sha>
git push
git switch feat/quotes-dev
git merge --no-ff -m "fix(ci): synchronize the base branch correction" feat/quotes
git push
```

An integration-only resolution may remain on `-dev`; every fix needed by the feature must reach the base. Always synchronize the base back into `-dev`: cherry-pick creates another SHA and CI checks ancestry as well as content. Open another `-dev` → dev PR and wait for successful CI/Deploy for that revision. Never merge dev into the base.

## 3. Promoting the ready base to staging

Open **`feat/quotes` → `staging`** once behavior is validated. Link base-branch guides and the successful dev Deploy containing the tested `feat/quotes-dev` revision. Dev may contain other features: staging receives only this base.

The gate verifies:

- The exact base SHA is an ancestor of the immutable integration SHA recorded as the second parent of a successful normal dev deployment merge. A direct commit, squash or octopus merge is not valid integration proof.
- Files changed by the candidate relative to the PR base SHA have identical content in the tested integration revision, including additions, deletions and renames. Other dev-only files can differ. An integration resolution that changes candidate files must be returned to the base and tested again.
- The successful deployment preserves the integration revision's entire tree. A reverted/overwritten deployment cannot establish that validation.
- The candidate staging merge tree matches the base tree.

Proof is tied to immutable candidate, integration and deployment SHAs, not the current sibling branch tip. Later pushes or deletion of `-dev` cannot change what was deployed; a new base SHA invalidates the old proof and triggers PR checks again. Keep the paired branches for development and promotion even though Git history preserves completed deployment proof. The gate reports its selected deployment and tested integration SHAs.

Deployment lookup processes pages of at most 100 runs, retains only successful SHAs and stops when it finds a valid candidate; it does not download all history into memory. Without a valid deployment, promotion remains blocked.

If staging advances, update the base from `origin/staging` through a normal merge, resolve candidate compatibility there and synchronize into `-dev`. Repeat tests and dev PR/Deploy before promotion; do not approve an untested combined result. The gate alone does not establish business acceptance tests.

Keep both remote branches until promotion is complete. Use **normal merges** in these PRs, including `-dev` → dev: squash/rebase removes ancestry needed to establish deployment. Do not automatically delete `-dev` after its first PR. Do not use Update branch if it would bring dev into the base.

## 4. Publishing a staging release to prod

Staging Deploy reruns CI, publishes staging and validates infrastructure. Test the candidate and open **`staging` → `prod`** for each release. Link the successful Deploy of the exact staging SHA, release guides and checks. CI requires that deployment and a merge preserving the source tree. Use a normal merge and wait for successful prod Deploy.

If prod merge history needs to return to staging, use a maintenance base originating from staging and its `-dev` partner, following the same flow. Never push directly or copy all dev changes. `main` is a historical reference without deployment.

## Protections and PR documentation

All three branches require PRs, `policy`, `validate` and `codex-review` checks, an up-to-date branch and resolved conversations; this also applies to administrators. Dev requires no human approval. Staging/prod normally require one approval. An explicitly authorized exception affects only the requested promotion: preserve CI and restore the temporary approval requirement.

Each PR waits for Codex review of its current SHA and checks relevant technical criteria. Follow [change review](../change-review.md) to give the reviewer accessible context, record evidence and resolve findings or consult the user. Review does not replace CI or required human approval; it also does not establish completion of an entire story.

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
| Secret | CLOUDFLARE_API_TOKEN | Deployment token for the configured account |

Runtime/web values belong to the environment and must preserve provisioned credentials. Never put an administrative URL, root password or client certificates in GitHub. CD uses runtime credentials to check SQL and the Cloudflare API to publish. The account ID stays fixed in configuration.

Create a Cloudflare token limited to the configured account with **Workers Scripts: Edit**, **Workers Tail: Read**, **Account Settings: Read**, **Hyperdrive: Read** and **Account: SSL and Certificates: Read**. The flow needs neither Hyperdrive Edit, zone routes nor certificate-creation permission. Workers Tail Read is part of usual Wrangler publishing permissions. Workers Scripts authorization covers the account, so environment selection also depends on repository controls and verified bindings.

GitHub environment policies allow only their matching branch: dev, staging or prod. PRs receive no remote credentials; only the post-CI Deploy job restores them. Secrets are always cleaned afterward. Provision all required resources before integrating dependent changes.

An account-level Workers Scripts token can modify Workers in other environments. Branches/environments do not constrain that scope within Cloudflare: code integrated into dev receives a token potentially capable of publishing over prod. This foundation assumes trusted collaborators and has no real users. Before real data, define isolation through separate Cloudflare accounts or mandatory review of executable infrastructure/CI changes. Distinct tokens with identical account scope do not solve this limit by themselves.

## Migrations and recovery

[Migration procedures](migrations.md) are the single reference for creating SQL, validating permissions, applying approved candidates before integration and reconciling failures. CD uses only runtime roles: it checks schema before publication and never receives administrative credentials or applies remote DDL.

Deploy does not automatically roll back after a failed post-deployment check. Prepare a compatible revision through the same Gitflow and verify it before promotion. Worker rollback does not revert SQL/data; preserve migrations/checksums and follow that guide's recovery procedure.
