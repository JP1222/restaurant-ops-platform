# ADR-0014: Sentry SaaS chosen over self-hosted GlitchTip for app-side error tracking

- **Status**: Accepted
- **Date**: 2026-05-26
- **Deciders**: @example-org
- **Supersedes (partial)**: the SDK-side of the observability roadmap implied by ADR-0007 era work in [docker-compose.observability.yml](../../docker-compose.observability.yml) and [.github/OBSERVABILITY.md](../../.github/OBSERVABILITY.md).

> **⚠️ Shared ADR number.** The number **0014** is also used by [`0014-manual-deploy-trigger.md`](0014-manual-deploy-trigger.md) — a parallel-branch collision (both authored 2026-05-26). Per the immutability convention ([README](README.md#superseding-an-adr): *"Never delete an ADR"*; numbers are never reused-by-renaming), neither was renumbered. Cite the full filename, not the bare number, when cross-referencing. **This** ADR is the *Sentry SaaS over GlitchTip* one.

## Context

The May 2026 observability work shipped a self-hosted error tracker (GlitchTip) on Oracle as part of [docker-compose.observability.yml](../../docker-compose.observability.yml). [.github/OBSERVABILITY.md](../../.github/OBSERVABILITY.md) §First-time setup step 4 explicitly planned for "4 GlitchTip projects (one per app), grab the DSN of each ... Save the 4 DSNs — they'll be needed for the next PR (Sentry SDK integration)."

Before opening that SDK integration PR, the operator reviewed the SaaS-vs-self-hosted tradeoff and chose Sentry SaaS instead. This ADR captures the decision; the implementation plan lives at docs/phase-5b-sentry-saas-integration.md.

## Decision

App-side error tracking from `kds-api`, `kds-web`, `analytics-api`, `backoffice-web`, and `crew-web` sends events to **`sentry.io`** (org `restaurant-ops-platform`, 5 projects), **not** to the self-hosted GlitchTip at `errors.example.com`.

5 Sentry projects created via API:

| project slug | platform | Dokploy stack | env var name |
| --- | --- | --- | --- |
| `kds-api` | node | rop-kds | `KDS_API_SENTRY_DSN` |
| `kds-web` | javascript-nextjs | rop-kds | `KDS_WEB_SENTRY_DSN` |
| `analytics-api` | node | rop-analytics | `ANALYTICS_SENTRY_DSN` |
| `backoffice-web` | javascript-nextjs | rop-backoffice | `BACKOFFICE_SENTRY_DSN` |
| `crew-web` | javascript-nextjs | rop-crew | `CREW_SENTRY_DSN` |

DSN values live in Dokploy compose env (per-stack). The shared CI-time `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` are mirrored to 1Password (`Example Kitchen Dokploy` item) and synced to GitHub Actions secrets via the existing [`scripts/sync-github-secrets-from-agent-env.sh`](../../scripts/sync-github-secrets-from-agent-env.sh) flow (see [agent-secret-workflow.md](../agent-secret-workflow.md)).

The GlitchTip stack remains deployed as a warm fallback until a follow-up PR removes it (see *Follow-ups* below).

## Why SaaS over self-hosted GlitchTip

**Makes easy:**

- **Better symbolication + replay tooling out of the box.** GlitchTip supports source maps but Sentry's `withSentryConfig` + suspect-commit + "regression in release" detection is more mature, especially for Next.js 16 standalone builds.
- **No new stateful service on a single-host Oracle box.** the dokploy-disk-pressure-incident memory (agent-local, not tracked in the repo) showed Oracle is already trending toward overlayfs exhaustion. Removing GlitchTip's 4 services (postgres / redis / web / worker) frees ~650 MB RAM + their disk volumes.
- **Alert routing is one-click to email / Slack** on Sentry's side; GlitchTip alert plumbing is comparatively manual.
- **Sub-10-minute bootstrap.** Sign up, click "create project" 5×, copy DSNs into Dokploy → done. The self-hosted path required the operator to babysit Django migrations + close public-registration in the GlitchTip UI.

**Makes hard:**

- **Cost beyond the free tier.** Sentry Team plan starts at 5k events/mo free. At single-merchant Example Kitchen scale this is comfortably under-quota; revisit if volume crosses the threshold.
- **Data residency: restaurant PII would leave the Oracle box and live on Sentry infrastructure.** Mitigated by `sendDefaultPii: false` + `packages/contracts/src/sentry-scrub.ts` (a shared `beforeSend` that strips customer name / phone / email / notes, provider tokens, session secrets, and `Authorization` / `Cookie` headers before any payload leaves the process). Reviewers should flag any code that bypasses the scrubber.
- **Vendor lock-in (mild).** The SDK packages (`@sentry/node`, `@sentry/nextjs`) are identical whether self-hosted or SaaS; switching back is one DSN change away. Lock-in is operational (alert configs, project structure) not technical.

**New risks:**

- **PII leak through misconfigured `beforeSend`.** Mitigated by: (a) explicit allowlist in `packages/contracts/src/sentry-scrub.ts`, (b) Sentry server-side data scrubbing as second layer (project setting), (c) vitest coverage in `packages/contracts/src/sentry-scrub.test.ts` (8 tests covering PII, headers, nested objects, arrays).
- **SaaS outage hides app outages.** If Sentry is down, the SDK's local buffer drops events after retry. Grafana + Loki cover the gap for log-based forensics (untouched by this ADR).
- **Auth-token leak.** `SENTRY_AUTH_TOKEN` has `project:releases` scope, which could pollute the issue stream or delete releases if leaked. Mitigated by 1Password-only storage (`op://` reference in `.env.tpl`), stdin-only `gh secret set` (no `--body`), and the operator's commitment to rotate the bootstrap token created on 2026-05-26 (it briefly appeared in agent chat during initial setup).

## Alternatives considered

- **Self-hosted GlitchTip as planned.** The May 2026 default. Rejected for the symbolication + ops-burden + memory-budget reasons above. The operational savings at single-merchant scale outweigh the SaaS cost.
- **GlitchTip on a separate host.** Considered. Adds a host to maintain; doesn't solve the symbolication ergonomics gap.
- **Both (dual-write).** Considered. Doubles event volume + config surface for marginal gain.

## Consequences

- 5 Sentry projects exist in the SaaS org `restaurant-ops-platform`. They're recorded in docs/phase-5b-sentry-saas-integration.md §Architecture.
- The GlitchTip services in `docker-compose.observability.yml` are now in a "deprecated but running" state. `.github/OBSERVABILITY.md` is updated to point operators at this ADR + the Phase 5b plan; the §Known gaps row for "Sentry SDK in 4 apps" becomes the follow-up tracker for tearing GlitchTip down.
- `packages/contracts` now exports a `scrubEvent` helper. Cross-app DTO boundary (Iron Law 2) unchanged.
- `apps/crew-web` gains a workspace dep on `@rop/contracts` (previously had none), required by its `sentry.{server,client}.config.ts` import of `scrubEvent`. crew-web's `next.config.ts` adds `transpilePackages: ["@rop/contracts"]` to keep the workspace import resolvable inside Next.js's bundler.

## Follow-ups (tracked separately)

1. **Tear down GlitchTip** in `docker-compose.observability.yml` once Sentry has been live ≥7 days without complaint. Removes services `glitchtip-postgres` / `glitchtip-redis` / `glitchtip-migrate` / `glitchtip-web` / `glitchtip-worker`. Frees ~650 MB RAM on Oracle. Updates `.github/OBSERVABILITY.md` §Surfaces. — ✅ Done 2026-05-28 — GlitchTip services + volume removed from `docker-compose.observability.yml` and torn down on Oracle.
2. **Client-side error capture (browser-side init).** This PR ships `sentry.client.config.ts` files but the bundled DSN is empty at build time (we only thread `SENTRY_DSN` at runtime, not `NEXT_PUBLIC_SENTRY_DSN` as `--build-arg`). Client init is therefore a no-op today. A follow-up wires `NEXT_PUBLIC_<APP>_SENTRY_DSN` through GHA → Docker `--build-arg` → ENV so the client bundle bakes in the DSN. Until then, browser errors are captured indirectly via `captureRequestError` re-export from `instrumentation.ts` for SSR-path errors only. — ✅ Done 2026-05-28: the three Next.js Dockerfiles' **build** stage now takes `NEXT_PUBLIC_SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_RELEASE` (baked into the browser bundle) plus `SENTRY_ORG`/`SENTRY_RELEASE` and a `sentry_auth_token` **BuildKit secret** — the latter also activates the already-configured `withSentryConfig` **source-map upload** (previously dormant because the build stage never saw `SENTRY_AUTH_TOKEN`). `build-images.yml` threads the per-app DSN via `secrets[matrix.sentry_dsn_secret]`. Everything defaults empty → no-op until the per-app DSN secrets (`KDS_WEB_SENTRY_DSN` / `BACKOFFICE_SENTRY_DSN` / `CREW_SENTRY_DSN`) + `SENTRY_AUTH_TOKEN` exist as GitHub secrets and the apps redeploy.
3. **CPU profiling re-enable.** `@sentry/profiling-node` was removed from `kds-api` / `analytics-api` because its native binding requires pnpm's `onlyBuiltDependencies` allowlist; not configured in this PR. Follow-up: add the allowlist, re-install the dep, re-add `nodeProfilingIntegration()` to both `lib/sentry-init.ts` modules.
4. **Cross-service trace propagation.** Today each app traces in isolation. A follow-up wires `sentry-trace` + `baggage` headers through `backoffice-web` → `kds-api` + `backoffice-web` → `analytics-api` internal admin calls so a single user action shows up as one distributed trace.
5. **Tune sample rates.** `tracesSampleRate: 0.05` is conservative; review Sentry quota usage after 2 weeks and adjust.
6. **Alert routing to Slack.** Configure Sentry alert rules to the existing Slack webhook (currently used for Dokploy redeploy notifications).
7. **iOS app SDK.** Add `sentry-cocoa` SPM dependency when iOS KDS goes to production.

## Related

- docs/phase-5b-sentry-saas-integration.md — implementation plan + executor checklist.
- [ADR-0007](./0007-validate-compose-env-script.md) — env-drift guardrail; the new `<APP>_SENTRY_DSN` keys were added to both Dokploy env DB and compose YAML in the same PR (validated locally via `op run --env-file=.env.tpl -- python3 scripts/validate-compose-env.py`).
- [docs/agent-secret-workflow.md](../agent-secret-workflow.md) — the 1Password → `op run` → stdin → `gh secret set` pipeline now also carries `SENTRY_AUTH_TOKEN` + `SENTRY_ORG`.
- [docker-compose.observability.yml](../../docker-compose.observability.yml) — the self-hosted GlitchTip stack this ADR deprecates.
