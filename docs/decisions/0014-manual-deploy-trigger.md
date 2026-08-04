# ADR-0014: Manual deploy trigger (merge ≠ deploy)

- **Status**: Accepted
- **Date**: 2026-05-26
- **Deciders**: @example-org

> **⚠️ Shared ADR number.** The number **0014** is also used by [`0014-sentry-saas-over-glitchtip.md`](0014-sentry-saas-over-glitchtip.md) — a parallel-branch collision (both authored 2026-05-26). Per the immutability convention ([README](README.md#superseding-an-adr): *"Never delete an ADR"*; numbers are never reused-by-renaming), neither was renumbered. Cite the full filename, not the bare number, when cross-referencing. **This** ADR is the *manual deploy trigger* one.

## Context

Pre-this-ADR, `.github/workflows/build-images.yml` triggered on `push: branches: [main]`. Every merge to `main` automatically built Docker images, pushed to GHCR, and fired the per-app Dokploy redeploy webhook. This coupled two independent concerns:

1. **Code integration** — "is the PR worth merging into the trunk?" Gated by `ci.yml` (lint + test + e2e).
2. **Production release** — "should the current trunk go live on `*.example.com`?" Previously implicit: every merge.

The implicit coupling caused several pain points:

- AI-assisted merges (admin-bypass self-merge after CI green, per ops convention) shipped to production with no separate operator review of deploy timing.
- Batching multiple small merges before deploying required temporarily disabling the workflow.
- Hotfixes raced CI on `main` — there was no "stage now, ship later" mode.
- Rollback assumed code state == prod state: revert on main to rebuild, or hand-redeploy a prior GHCR tag in the Dokploy UI.

## Decision

`build-images.yml` triggers exclusively on `workflow_dispatch`. Both the `push: branches: [main]` and `pull_request:` triggers are removed — no build runs without an explicit operator dispatch. Dockerfile breakage is not pre-caught at PR time; it surfaces at the next deploy dispatch, which is acceptable for the current operator topology (AI-assisted writing + manual deploy decision).

Deploy becomes a deliberate operator action:

```bash
gh workflow run build-images.yml --ref main --field force_all=true
```

Or via the GitHub Actions UI → "Run workflow". `--field force_all=true` is the recommended default because `dorny/paths-filter`'s behavior on `workflow_dispatch` without a base ref is brittle.

CI (`ci.yml`) is unchanged. It still runs on every PR + push to main + manual dispatch, and remains a required check for branch protection. Merging is gated by CI; deploying is gated by human intent.

> **Update 2026-06-05:** the `push: main` trigger was removed from `ci.yml` (and `validate-compose.yml`). A merge no longer auto-runs CI on `main` — that run was largely re-testing what the PR's pre-merge run already validated, and it shared the 2-runner self-hosted pool with this manual deploy, so a merge-then-deploy made the two contend for runners (a multi-app deploy stretched to ~22 min). The **merge gate is unchanged** — the PR-context `ci.yml` checks (`Lint, build, test` + `E2E`) are still required by branch protection — and `workflow_dispatch` still allows an on-demand full CI run against `main`. The trade-off (losing the only run on the exact squashed `main` commit) and how to restore it are documented in the `ci.yml` header.

## Operator topology

Deploy authority and deploy execution are separated:

- **Deploy authority** (decision: *when* to ship): the human operator. Based on judgment of "feels ready" — accumulated merges, manual smoke testing, no in-flight critical bugs, off-hours window if needed.
- **Deploy execution** (action: *running* the trigger): typically an AI agent (Claude Code / Codex / Cursor) invoking `gh workflow run` per the canonical command and rules in [`AGENTS.md` → Deploy is user-gated](../../AGENTS.md).

This is intentional. Merging is automation-friendly (CI green → merge); deploying requires context beyond CI signal (recent prod state, batch shape, off-hours timing). Keeping execution scriptable but authority human-gated lets the AI handle the rote step without inheriting the judgment step.

## Consequences

Positive:

- `:main` GHCR tag and Dokploy state are explicit operator decisions, not side effects of `git merge`.
- Batchable deploys: merge N PRs, deploy once when the batch is verified.
- Cleaner rollback story: revert on main is decoupled from rebuild; Dokploy can also pin to a known-good `:<sha>` tag without involving CI at all.
- Reduces blast radius of aggressive automation: an AI that self-merges no longer ships to prod by side effect.

Negative:

- `:main` GHCR tag lags `main` branch until a deploy is dispatched. Anyone assuming `ghcr.io/.../rop-<app>:main` ≡ HEAD of `main` is now wrong. Production-state queries must consult Dokploy's deployed image SHA, not the repo.
- One more manual step. Deploy requires a CLI call (typically by AI agent on user instruction) or a UI click. Acceptable given the operator topology.
- Documentation churn. README, HANDOFF, DOKPLOY_RUNBOOK, BRANCH_PROTECTION, agent-secret-workflow, AGENTS.md all referenced the old auto-deploy semantics. All updated in the same PR.

Neutral:

- Per-app dispatch (`inputs.apps`) is desirable but out of scope for this ADR. Tracked as a follow-up.

## Alternatives considered

- **Keyword opt-in** (`[deploy]` in commit message). Rejected: keeps the auto-trigger surface area, adds parse-the-message complexity, doesn't help the "batch and ship later" use case.
- **`release: types: [published]`**. Rejected: ceremony cost too high for the current solo + AI-assisted cadence. May reconsider if the team grows.
- **Branch-based** (push to `release/*` triggers deploy). Rejected: requires a second long-lived branch, adds merge/rebase overhead, doesn't fit GitHub Flow.
- **Status quo (push to main auto-deploys)**. Rejected: this is the failure mode that prompted the ADR — fine when humans gate the merge cadence, brittle when AI agents self-merge aggressively.

## Enforcement

This is policy, not a machine boundary. Reintroducing `push: branches: [main]` to `build-images.yml` is not blocked by lint. `pnpm docs:check` will catch missing ADR cross-references but does not currently parse workflow YAML to assert the trigger contract. Future enforcement (e.g., a script that asserts `build-images.yml` has no `push:` trigger) is tracked as a follow-up.
