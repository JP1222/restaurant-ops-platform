# ADR-0007: `validate-compose-env.py` guardrail against env drift

- **Status**: Superseded by [ADR-0522](0522-remove-dokploy-and-swarm.md)
- **Date**: 2026-05-18 (PR #48 merged)
- **Deciders**: @example-org

## Context

Dokploy (chosen in [ADR-0005](./0005-dokploy-over-coolify.md)) stores environment variables in **two separate places**:

1. **Per-compose env DB** — entered through Dokploy UI or `compose.saveEnvironment` tRPC. Stored as a multi-line `KEY=value` string in Dokploy's own Postgres.
2. **Compose YAML's `environment:` block** — declared in `compose-dokploy/*.yml`, references `${VAR}` placeholders. Dokploy interpolates from (1) at deploy time.

For a value to actually reach a container, **both** layers must agree:

```yaml
# compose-dokploy/kds.yml
services:
  kds-api:
    environment:
      CLOVER_TOKEN: ${CLOVER_TOKEN}   # ← reference in YAML
```
```
# Dokploy compose env DB
CLOVER_TOKEN=eyJhbGc...               # ← value in Dokploy
```

Two failure modes:

- **Compose references `${VAR}` but Dokploy's env DB has no `VAR=` entry.** Container starts with `VAR=""` (or unset). App's zod env parse fails at startup → restart loop. **Loud failure** — visible immediately.

- **Dokploy's env DB has `VAR=value` but compose YAML's `environment:` block doesn't pass it through.** Container starts; app reads `process.env.VAR` → `undefined`. The value exists in Dokploy's UI (so the operator believes they configured it), but it never reached the container. **Silent failure** — manifests as "feature X doesn't work" hours or days later.

The silent-failure class hit production **twice on 2026-05-18**:

- **PR #45** — added `BACKOFFICE_BASE_URL` and `ANALYTICS_ADMIN_TOKEN` to Dokploy's env, forgot to add the `environment:` lines to `compose-dokploy/backoffice.yml`. Backoffice's `/api/*` admin endpoints returned 401 on every call. Took ~30 minutes to diagnose because the Dokploy UI showed both values set.

- **PR #47** — added `ADMIN_TOKEN` and `BACKOFFICE_BASE_URL` to Dokploy's analytics compose env, forgot to wire them into `compose-dokploy/analytics.yml`. Backoffice → analytics-api admin calls 401'd. Same diagnostic pattern, ~20 minutes to fix once the previous incident's lesson was fresh.

The pattern was clear: this would happen every time someone added a new env var unless we built a guardrail.

## Decision

Add `scripts/validate-compose-env.py` (script since removed), a CI job that compares the two layers and fails the PR when they're inconsistent.

**Two cross-checks per app:**

1. **Required refs missing in Dokploy** (error → fail PR).
   For every `${VAR}` reference in `compose-dokploy/<app>.yml` **without a `:-default` fallback**, Dokploy's env DB must have a `VAR=…` entry. If not, error.

2. **Dangling Dokploy keys** (warn today, error once clean).
   For every key set in Dokploy's compose env DB, the compose YAML's `environment:` block must reference it (directly via `KEY: ${KEY}` or with a default). If not, that's the PR #45 / PR #47 class of bug — flag it.

The validator:
- Fetches Dokploy env via `compose.one` tRPC, parsing the multi-line `env` field into a set of keys.
- Parses `compose-dokploy/<app>.yml` with a regex for `${VAR}` and `${VAR:-default}` references.
- Emits GitHub Actions annotations (`::error file=…::`) so the PR diff highlights the offending line.

Wired into `ci.yml` as the `validate-compose` job. Requires repo secrets `DOKPLOY_API_KEY` + per-stack `DOKPLOY_*_COMPOSE_ID`.

**`FAIL_ON_DANGLING` defaults to `0` (warn-only)** because at PR #48 merge time, kds and analytics already had pre-existing dangling entries from the PR #45 / PR #47 fixes. Flipping to `1` is a follow-up once those are cleaned (tracked in the script's docstring).

## Consequences

**Makes easy:**

- **PR #45 / #47 class of bug becomes impossible to merge.** The validator runs against the live Dokploy env DB; the bad PR fails CI before merge. Reviewers no longer have to remember to mentally cross-check.
- **Operator-friendly error messages.** The annotation tells you which file, which var, which side is wrong, and what the fix is. No archaeology required.
- **Dependabot PRs degrade gracefully.** If `DOKPLOY_API_KEY` is unset (Dependabot can't see secrets), the script emits a `::warning::` and exits 0. The validator becomes advisory on external-fork PRs and authoritative on internal PRs that get merged to main.

**Makes hard:**

- **CI depends on Dokploy being up.** If `dokploy.example.com` is unreachable from GHA runners, the validator fails. Mitigation: tRPC fetch has a 15s timeout; transient failures retry naturally on PR rebase.
- **Secret sprawl.** Three new secrets (`DOKPLOY_KDS_COMPOSE_ID` etc.) plus the existing `DOKPLOY_API_KEY`. Documented in [`OPERATIONS.md` §2.9](../../OPERATIONS.md#29-configure-github-actions-secrets).
- **The source of truth is now Dokploy's env DB, not the repo.** A reviewer can't tell from the PR diff alone whether the env DB has been updated; they have to trust CI. This is acceptable because CI catches the inconsistency, but it does require the CI signal to be reliable.

**New risks:**

- **Race condition between Dokploy env edit and PR merge.** If the env is being edited at the same time CI runs, the snapshot the validator sees may be inconsistent. In practice we don't edit env and PR-merge simultaneously, but it's a theoretical hole.
- **`FAIL_ON_DANGLING=0` is a temporary state.** The script's docstring tracks the cleanup needed. If "temporary" becomes "permanent", we lose half the value of the validator. The follow-up should not be forgotten.

## Alternatives considered

- **Trust review.** What we tried for PRs #1–#47. Failed twice in a 24-hour window. Reviewers (human or AI) can't reliably mentally cross-reference a YAML file's `environment:` block with a separate UI's env list.

- **Generate compose YAML from Dokploy env at deploy time.** Considered. Would eliminate the drift class entirely (single source of truth). Rejected because the YAML is also a source of truth for other things (networks, labels, healthchecks, build args) and round-tripping through Dokploy's API would lose readability and review-ability. The two-layer model is the cost of having both: structured config (YAML) and operator-friendly env editing (Dokploy UI).

- **Runtime alerting only.** "App will start, fail to read VAR, log an error, GlitchTip catches it." This is the fallback today. But the diagnostic loop is "user reports feature broken → grep logs → realize env is missing → trace to Dokploy UI → fix → redeploy". That's hours; a CI check is seconds. Runtime alerting is the *catch* if validate-compose somehow misses; not a substitute.

- **Pre-commit hook locally.** Considered. Rejected because:
  (a) Hooks are skipable (`--no-verify`).
  (b) The Dokploy API call needs `DOKPLOY_API_KEY`, which we don't want on every contributor's machine.
  (c) CI runs the check regardless, so the local hook would be redundant.

- **Manual diff in CHANGELOG every env-var change.** Some teams do this. Rejected — at our scale the friction is worse than the rare miss.

## Implementation notes

The validator is ~150 lines of Python with stdlib-only imports. Key behaviors documented in the script's docstring:

- Regex pattern matches `${VAR}`, `${VAR:-default}`, `${VAR-default}`, `${VAR:?error}`. The trailing `-` or `?` indicates a default/error is provided (so the var isn't strictly required).
- Skips gracefully on Dependabot / external-fork PRs (no `DOKPLOY_API_KEY` access).
- Exit code 1 if any error-level finding occurred; 0 otherwise.

Local invocation:
```bash
export DOKPLOY_API_KEY=…
export DOKPLOY_KDS_COMPOSE_ID=…
export DOKPLOY_ANALYTICS_COMPOSE_ID=…
export DOKPLOY_BACKOFFICE_COMPOSE_ID=…
export DOKPLOY_LEGAL_COMPOSE_ID=…
export DOKPLOY_MARKETING_COMPOSE_ID=…
export DOKPLOY_CREW_COMPOSE_ID=…
python3 scripts/validate-compose-env.py
```

## Related

- [ADR-0005: Dokploy v0.29 chosen over Coolify v4](./0005-dokploy-over-coolify.md) — context for why env lives in two layers.
- [`OPERATIONS.md` §3.2](../../OPERATIONS.md#32-ciyml--the-merge-gate) — how this validator fits into the merge gate.
- [`OPERATIONS.md` §6.4](../../OPERATIONS.md#64-env-drift-caught-by-ci) — operator runbook for when the validator fires.
- PRs [#45](https://github.com/example-org/restaurant-ops-platform/pull/45), [#47](https://github.com/example-org/restaurant-ops-platform/pull/47), [#48](https://github.com/example-org/restaurant-ops-platform/pull/48) — incident PRs + the validator.
