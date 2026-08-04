# Branch protection setup for `main`

> **Status:** current — initial setup already executed; this is the reconfiguration reference.

One-time setup. Configures GitHub so that `main` can only be updated through a
green-CI pull request.

Do this **after** the new `ci.yml` has run at least once (status check names
need to exist in GitHub before they can be selected as required checks).

## Step 0 — let CI run once

1. Merge this branch into `main` so `.github/workflows/ci.yml` lives there.
2. Open any PR (even a no-op typo fix). Confirm the `CI / ci` check shows up
   under the PR's checks tab and finishes green.
3. Now GitHub knows the check exists and you can require it.

## Step 1 — create the ruleset

GitHub web UI:

1. Repo → **Settings** → **Rules** → **Rulesets** → **New ruleset → New branch ruleset**
2. **Ruleset name**: `Protect main`
3. **Enforcement status**: `Active`
4. **Bypass list**: leave empty (or add yourself as "Repository admin" with
   "for pull requests only" if you want an escape hatch for emergencies)
5. **Target branches**: click **Add target** → **Include default branch**

## Step 2 — enable the rules

Check these boxes:

| Rule | Setting |
|---|---|
| Restrict deletions | ✓ |
| Block force pushes | ✓ |
| Require linear history | ✓ (keeps `git log` clean — no merge bubbles) |
| Require a pull request before merging | ✓ |
| &nbsp;&nbsp;↳ Required approvals | `0` — solo + AI repo: no human reviewer exists, so any `>0` value just forces `--admin` bypass on every PR. Green CI is the real gate. Re-enable when a human teammate joins. |
| &nbsp;&nbsp;↳ Dismiss stale pull request approvals when new commits are pushed | ✓ |
| &nbsp;&nbsp;↳ Require approval of the most recent reviewable push | ✓ |
| Require status checks to pass | ✓ |
| &nbsp;&nbsp;↳ Add checks → select **`Lint, build, test`** + **`E2E`** only (the two always-run, stable-named jobs). Do NOT require `Migration smoke-test (...)`: its job name keeps changing (it gained `+ db-inventory`), and a renamed required check becomes a "ghost" that blocks every PR forever — a stale `E2E + migrations` context did exactly this, forcing `--admin` bypass on every merge until fixed 2026-05-28. A broken migration still shows red to the author and is re-validated at deploy. | ✓ |
| &nbsp;&nbsp;↳ Require branches to be up to date before merging | ✗ (causes friction in 2-person team; turn on later if you want) |

Click **Create**.

## Step 3 — verify

1. Try to push directly to `main` from your local machine:
   ```bash
   git checkout main && git commit --allow-empty -m "test" && git push
   ```
   Should be rejected by GitHub. Undo with `git reset --hard origin/main`.
2. Open a PR. Confirm:
   - "Merge" button is disabled until CI is green.
   - "Merge" button is disabled until your teammate approves (or you approve
     your teammate's PR).

## Optional hardening (later)

- **CODEOWNERS file** (`.github/CODEOWNERS`): auto-request reviews from
  specific people based on which files changed.
- **Required deployments**: gate `main` on a successful `staging` deploy.
- **Require signed commits**: cryptographic provenance. Adds setup friction;
  skip until you have a reason.

## Deploy chain

CI gates merges, but deploys are a separate manual action (see
[ADR-0014](../docs/decisions/0014-manual-deploy-trigger.md)).

When a PR merges to `main`:

1. `ci.yml` runs lint + build + test on the Mac Mini self-hosted runner
   and must go green (status check enforced by the ruleset above).
2. **Nothing else happens automatically.** No images rebuild, no deploy.
   The merge integrates the code; production stays on its current image.

To deploy, dispatch the build workflow:

```bash
gh workflow run build-images.yml --ref main
```

Or click "Run workflow" in the Actions tab. The deploy chain then runs
(plain `docker compose` over SSH — Dokploy + Swarm were removed; see the
Dokploy-removal ADR):

1. `build-images.yml` on the self-hosted Mac Mini arm64 runner. Each app
   in scope builds a Docker image and pushes to
   `ghcr.io/example-org/rop-<app>:main` (and `:<sha>`).
2. The workflow then **SSHes to the Oracle host** and runs
   `scripts/deploy-stack.sh <stack>` for each changed stack, which git-syncs
   the host checkout to `main` and runs `docker compose -f compose/<stack>.yml
   [--env-file compose/<stack>.env] pull && up -d`.
3. `compose/*.yml` is validated by `validate-compose.yml`
   (`docker compose config`) on PRs; there is no separate sync step —
   `deploy-stack.sh` reads the file straight from the synced checkout.
4. Workflow failures notify Slack via `slack-notify.yml`.

To roll back, revert the offending commit and dispatch `build-images.yml`
to rebuild from the prior code, or pin the previous `:<sha>` image in the
stack's `compose/<stack>.yml` and redeploy. The deploy/rollback
runbook lives in [OPERATIONS.md](../OPERATIONS.md).

### Required repository secrets

| Secret | Purpose |
|---|---|
| `ORACLE_SSH_KEY` | Private SSH key for the deploy user on the Oracle host (used by `build-images.yml` to run `scripts/deploy-stack.sh`). |
| `ORACLE_SSH_HOST` | Oracle host address for the SSH deploy step. |
| `SENTRY_AUTH_TOKEN` | Build-time Sentry sourcemap/release upload. |
| `SENTRY_ORG` | Sentry org slug for the build step. |
| `SLACK_WEBHOOK_URL` | Channel webhook for failure notifications. |

(The `ORACLE_SSH_*` pair **replaced** the entire former `DOKPLOY_*` set —
API key, per-stack compose IDs, and redeploy webhooks — none of which exist
anymore. Runtime app secrets are not GitHub secrets: they come from Infisical
at container boot, ADR-0020.)

### Subscribing teammates to failure emails

GitHub auto-emails the commit author when a workflow fails on `main`. To
also notify teammates:

- GitHub avatar → Settings → Notifications → Actions → enable Email
- Watch the repo → Custom → tick Actions

(Slack notifications are the primary teammate-facing channel; email is
the per-author backstop.)

## Why this specific combo

- **Linear history** + **block force pushes**: history can be reasoned about
  with `git log --first-parent`; no rewrites surprise the deploy server.
- **Dismiss stale approvals**: prevents "approved 3 commits ago, then they
  snuck a payment-flow change in" pattern.
- **Required status check is the CI job, not the workflow**: GitHub treats
  job names as status checks. If you rename the job in `ci.yml`, you must
  re-select it here.
