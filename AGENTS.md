# Example Kitchen Suite

Example Kitchen is a **multi-tenant restaurant platform** (Toast-style: `Tenant → Location → Device`), currently running **one tenant** — the owner's brand, with two locations (Anytown on Clover, store #2 on Square), co-managed by the owner and a partner. The codebase is a pnpm monorepo combining multiple product domains plus shared packages. The target architecture and the phased path there are canonical in [docs/architecture/multi-tenant-architecture.md](docs/architecture/multi-tenant-architecture.md) and [docs/multi-tenant-migration-roadmap.md](docs/multi-tenant-migration-roadmap.md); **multi-location is the within-tenant shape, not the top of the model** (see [docs/multi-location.md](docs/multi-location.md); [ADR-0018](docs/decisions/0018-multi-location-architecture.md)'s "not multi-tenant" stance is superseded by the multi-tenant ADR). `tenant_id` is the trust boundary; `merchantId`/`locationId` are partition keys underneath it.

## Apps

| Path | Role | Stack | AGENTS |
| --- | --- | --- | --- |
| `apps/kds-api` | Fastify backend for KDS (Clover sync, KDS state, WebSocket fanout) | Fastify + Prisma + Redis + BullMQ | [apps/kds-api/AGENTS.md](apps/kds-api/AGENTS.md) |
| `apps/kds-web` | Next.js board / customer-display / login (Floor product) | Next.js + custom CSS | [apps/kds-web/AGENTS.md](apps/kds-web/AGENTS.md) |
| `apps/analytics-api` | Clover -> Postgres data pipeline (OLAP) | Node http + raw SQL + zod + Luxon | [apps/analytics-api/AGENTS.md](apps/analytics-api/AGENTS.md) |
| `apps/backoffice-web` | Next.js admin / analytics / inventory UI (auth + shell + BFF foundation) | Next.js 16 + Tailwind v4 + shadcn/ui | [apps/backoffice-web/AGENTS.md](apps/backoffice-web/AGENTS.md) |
| `apps/inventory-api` | Fastify backend for inventory persistence (items, waste, counts, POs, vendors); serves both `crew-web` (Floor) and `backoffice-web` (Backoffice) | Fastify + Prisma (`db-inventory`) | [apps/inventory-api/AGENTS.md](apps/inventory-api/AGENTS.md) |
| `apps/legal-site` | Static EULA + Privacy Policy + Support site for the Clover Marketplace listing | Vanilla HTML/CSS + zero-dep markdown -> HTML build, served by nginx; deployed via plain docker compose + Traefik on the Oracle host | [apps/legal-site/AGENTS.md](apps/legal-site/AGENTS.md) |
| `apps/marketing-site` | Static customer-facing marketing site at `www.example.com` (Anytown storefront, menu, gift cards, mall map) | Vanilla HTML/CSS + single-file vanilla JS, served by nginx; deployed via plain docker compose + Traefik on the Oracle host | [apps/marketing-site/AGENTS.md](apps/marketing-site/AGENTS.md) |
| `apps/crew-web` | Floor inventory app for line cooks (PIN login, ES-first, record waste / receive / 86 / quick recount). iPad + phone. Distinct from `kds-web` (ticket display) and `backoffice-web` (manager admin). | Next.js 16 + Tailwind v4 + React 19; PIN login wired to `inventory-api`, deployed at `crew.example.com` (floor-action UI still maturing) | [apps/crew-web/AGENTS.md](apps/crew-web/AGENTS.md) |
| `apps/order-web` | Customer-facing online ordering at `order.example.com` (menu → build a roll → Clover Hosted Checkout, pickup at Anytown). Phone-first, linked from `marketing-site`. Customer surface, distinct from Floor/Backoffice (Iron Law #4). | Next.js 16 + Tailwind v4 + React 19; BFF wired to `kds-api` `/api/order/*`, deployed at `order.example.com` (Clover checkout sandbox-verified; prod live-pay pending `NEXT_PUBLIC_CLOVER_*` + rebuild) | [apps/order-web/AGENTS.md](apps/order-web/AGENTS.md) |
| `apps/crm-api` | Fastify backend for loyalty/CRM (customers, append-only points ledger, rewards; POS-agnostic) | Fastify + Prisma (`db-crm`) | [apps/crm-api/AGENTS.md](apps/crm-api/AGENTS.md) |
| `apps/notifications-api` | Fastify backend for operator notifications (events behind the backoffice bell/inbox, per-operator read/snooze/dismiss state, delivery prefs). BFF-only; Phase 4 (read/prefs + backoffice BFF wiring + audited apply-action endpoint) built, deploy artifacts staged (user-gated), producers + realtime are later phases. See [ADR-0801](docs/decisions/0801-notifications-api-owns-the-operator-notification-domain.md). | Fastify + Prisma (`db-notifications`) | [apps/notifications-api/AGENTS.md](apps/notifications-api/AGENTS.md) |

## Packages

| Path | Role | AGENTS |
| --- | --- | --- |
| `packages/contracts` | Shared zod schemas + TS types for cross-app DTOs | [packages/contracts/AGENTS.md](packages/contracts/AGENTS.md) |
| `packages/db-kds` | KDS-specific Prisma schema + migrations + client | [packages/db-kds/AGENTS.md](packages/db-kds/AGENTS.md) |
| `packages/db-auth` | Auth Prisma schema + migrations + client (web_admin_accounts, web_authn_credentials). Same physical Postgres as `db-kds`; split at the Prisma package boundary — see [ADR-0015](docs/decisions/0015-extract-auth-tables-into-db-auth-package.md). | [packages/db-auth/AGENTS.md](packages/db-auth/AGENTS.md) |
| `packages/db-inventory` | Inventory Prisma schema + migrations + client (own Postgres) | [packages/db-inventory/AGENTS.md](packages/db-inventory/AGENTS.md) |
| `packages/db-crm` | Loyalty/CRM Prisma schema + migrations + client (own Postgres; `CRM_DATABASE_URL`). See [ADR-0021](docs/decisions/0021-loyalty-crm-domain.md). | [packages/db-crm/AGENTS.md](packages/db-crm/AGENTS.md) |
| `packages/db-notifications` | Notifications Prisma schema + migrations + client (own Postgres; `NOTIFICATIONS_DATABASE_URL`). Consumed only by `notifications-api`. See [ADR-0801](docs/decisions/0801-notifications-api-owns-the-operator-notification-domain.md). | [packages/db-notifications/AGENTS.md](packages/db-notifications/AGENTS.md) |
| `packages/auth` | Passkey + cookie session library shared by KDS and Backoffice | [packages/auth/AGENTS.md](packages/auth/AGENTS.md) |

## Suite-wide Iron Laws

1. **Database boundary**: Each app owns its own Postgres database. KDS uses Prisma via `packages/db-kds`; analytics-api uses raw SQL with its own schema; inventory uses Prisma via `packages/db-inventory`. Never cross-import database clients across apps.
2. **Contract boundary**: Cross-app DTOs flow through `packages/contracts` (zod). No hand-written DTOs at app boundaries.
3. **Auth boundary**: Once `packages/auth` lands, all cookie-session and passkey logic flows through it. No app reimplements auth.
4. **Floor vs Backoffice boundary**: `apps/kds-web` is a Floor product (board, customer-display, kitchen TVs and tablets). `apps/backoffice-web` is for owners and managers on desktop and mobile. Don't conflate the two - different UX, different refresh cadence, different error tolerance.
5. **Read sources are not write sources**: `apps/analytics-api` is read-only OLAP. It ingests Clover -> mart but never writes to KDS's database, and Backoffice never writes to either. All writes flow through the originating service.

## Deploy is user-gated

Code merges to `main` are AI-friendly: **the moment the required checks go green on your own PR, self-merge it (squash) — don't ask, green is the signal** ("wait for review" is not a separate gate; one human owner/operator). **Deploys are not.** `build-images.yml` is manual-only (see [ADR-0014](docs/decisions/0014-manual-deploy-trigger.md)) and must be triggered only on explicit user instruction ("deploy", "ship it", "trigger build", "build 一下", or equivalent).

Canonical command for AI agents:

```bash
# Default: incremental build. paths-filter compares HEAD against the
# `last-built` marker (the `.last-built` file on the `deploy-state` branch,
# advanced automatically after every successful dispatch), so only apps
# changed since the last deploy get rebuilt. Batched PRs since the last
# deploy all get picked up correctly.
gh workflow run build-images.yml --ref main

# Emergency / clean redeploy: force every app to rebuild regardless of
# marker state. Use this when (a) the deploy-state branch was deleted, (b) buildx cache is
# suspected corrupted, or (c) you explicitly want to redeploy everything.
gh workflow run build-images.yml --ref main --field force_all=true

# Then surface the run URL:
sleep 5
gh run list --workflow=build-images.yml --limit 1 \
  --json databaseId,status,url \
  --jq '.[0] | "Run #\(.databaseId): \(.status) → \(.url)"'
```

Rules:

- **Never trigger this unprompted.** A successful merge (including AI self-merge) does NOT imply a deploy.
- **Always use `--ref main`.** Even if your session is in a worktree or feature branch, deploy source-of-truth is `main`.
- **Default is the incremental path** (no `force_all`). The `advance-marker` job advances the `last-built` marker (a `.last-built` file on the `deploy-state` branch — **not** a git tag, because the Actions `GITHUB_TOKEN` can't push a tag whose diff crosses a `.github/workflows/**` change) after every successful build, so the next dispatch sees only the diff since then — correctly handles both single-app and batched-PR deploys. The workflow falls back to force_all semantics + a warning if the marker is missing or stale (first-ever deploy, or main was rewritten).
- **Report the run URL to the user.** Don't block on `gh run watch` — surface the URL and let the user follow.
- **On failure, do NOT auto-retry.** Repeated builds eat Mac buildx cache. Report with `gh run view <id> --log-failed | tail -50` and wait. The `last-built` marker is NOT advanced on failure, so the next dispatch will re-attempt the failed app(s).

## CI/CD philosophy

The pipeline is deliberately **lean, not comprehensive** — every gate must earn its cost. Validation sits where discovery is cheapest:

- **PRs** run lint / build / unit / integration / e2e — these are the required checks and they gate the merge. Fast and app-scoped via `dorny/paths-filter`.
- **Image builds and integration breaks surface at the manual deploy, not at PR time.** `build-images.yml` builds + pushes the real images, and a failure there is loud + Slack-alerted. Per-PR image validation (ADR-0036) and the `push:main` CI re-run were *deliberately removed* so a merge doesn't contend with the manual deploy on the **2-runner self-hosted Mac pool** — see [ADR-0014](docs/decisions/0014-manual-deploy-trigger.md), [ADR-0036](docs/decisions/0036-pr-time-image-build-coverage.md), and the `ci.yml` header.
- **The throughput ceiling is the 2 runners, not the pipeline design.** If builds feel slow, add a runner *machine* (and bump `max-parallel`) — don't add gates. Pipeline tuning is already exhausted.

Before adding a CI step, justify its cost against its failure-discovery value: a check that runs but never blocks a bad merge or deploy is waste, not safety.

## Machine-enforced boundaries

The Iron Laws are not honor-system. Most are enforced by checks that fail the build, so an agent that drifts gets a red `pnpm lint` / `pnpm docs:check` locally — not a review-time catch. See [ADR-0012](docs/decisions/0012-architecture-as-guardrails.md). If you must cross a boundary on purpose, write an ADR **and** add a scoped carve-out citing it (see [ADR-0011](docs/decisions/0011-ai-tables-bounded-exception.md) for the pattern). Silent crossing fails the build.

| Law | Enforced by | What fails |
| --- | --- | --- |
| 1 / 5 — DB boundary | `eslint.config.mjs` `no-restricted-imports` | `analytics-api` or `kds-web` importing `@rop/db-kds`; `backoffice-web` importing it outside `lib/ai/**` (ADR-0011) |
| 3 — Auth boundary | `eslint.config.mjs` `no-restricted-imports` | `@node-rs/argon2` imported outside `packages/auth`; `@rop/db-auth` imported outside `packages/auth/**`, the kds-api auth surface (`src/lib/services.ts`, `src/lib/admin-user-service.ts`, `src/routes/auth.ts`), or `apps/backoffice-web/lib/auth/**` (ADR-0015) |
| — Doc/schema drift | `scripts/check-doc-drift.sh` (`pnpm docs:check`) | a Prisma `model` missing from `ARCHITECTURE.md`; an app/package missing an `AGENTS.md`; a duplicate ADR number or a committed `0000-` ADR placeholder (ADR-0037) |
| — Dev-source resolution (yr-src) | `scripts/check-doc-drift.sh` (`pnpm docs:check`) | a `@rop/*` package missing the `yr-src` export condition; a tsx backend `dev`/`dev:worker` or a Next app `dev` missing the `config/yr-src-map.mjs` wiring; or a `yr-src`/`YR_SRC` token leaking into a `Dockerfile` or `compose/*.yml` |
| — Doc link integrity | `scripts/check-doc-links.py` (runs inside `pnpm docs:check`) | a tracked `.md` whose relative link points at a file that doesn't exist (intentional dead targets go in the script's `ALLOWLIST` with a reason) |
| — Compose validity | `validate-compose.yml` (`docker compose config`) | a `compose/*.yml` that fails to parse or references an undefined network/volume |
| — Runner policy | `scripts/check-runner-policy.py` (`pnpm runners:check`, runs in `ci.yml`) | a workflow `runs-on:` a GitHub-hosted (paid) runner without an `# allow-hosted:` carve-out (ADR-0008) |

Before declaring a task done, run `pnpm lint && pnpm build && pnpm test && pnpm docs:check` (add `pnpm test:integration` when you touched a backend / DB / migration path, and `pnpm test:e2e` when touching UI flows). Full testing reference: [docs/TESTING.md](docs/TESTING.md).

## Finding production errors (when debugging)

Two complementary query paths — **which one to use depends on the error class.** Picking the wrong one (e.g. trusting an empty Sentry) sends agents on a wrong turn. Full reference + symptom table: [.github/OBSERVABILITY.md](.github/OBSERVABILITY.md).

| Error class | Where to query | How |
| --- | --- | --- |
| **Server-side** — handled errors returned as 5xx, timeouts, any app log | **Loki** (complete; every container's stdout is shipped) | Grafana MCP, datasource `loki`, `{service="<app>"}` (label values are the bare app names). Fallback: `ssh oracle` → Grafana Explore. |
| **Browser / client crash** — white screen, JS error on a customer or floor device | **Sentry** (the ONLY source — these never touch the host's stdout, so Loki can't see them) | Sentry MCP, one project per app. Browser DSNs are live on kds-web / backoffice-web / crew-web / order-web. |
| **"Slow, nothing thrown"** — latency, queue depth, liveness | **Prometheus** | Grafana MCP (PromQL) or Grafana Explore. |

Two traps, both real:

- **A Sentry "no issues" is NOT "no errors."** Handled errors (`try/catch` → 5xx + `logger.error`) are logged to Loki but never reach Sentry. Always verify an empty Sentry against Loki.
- **An error often surfaces in a *different* app's backend than the one showing the symptom** — e.g. a crew-web invoice-scan failure is logged in **backoffice** under scope `backoffice.api.inventory.receipt-parse`, not in crew-web. Follow the call chain.

## Common commands

```bash
pnpm install
make dev-up           # one-time bootstrap: DBs + migrate + seed + admin (idempotent)
make dev              # launch the full local stack (6 apps); login admin / admin
pnpm build            # builds all workspace packages
pnpm lint             # lints all packages
pnpm test             # unit tests, all packages — mocked, fast, NO Docker
pnpm test:integration # integration tests — real ephemeral Postgres/Redis per suite (needs Docker); see docs/TESTING.md
pnpm test:e2e         # Playwright: kds-web (board / display) + backoffice-web (auth + dashboards) + crew-web (PIN login + invoice-scan / barcode-adjust / waste / receive / recount flows)
pnpm docs:check       # documentation drift checks
pnpm --filter @rop/<package> <script>
```

Per-app commands live in their respective `AGENTS.md`.

## AI agent conventions

- This file (`AGENTS.md`) is the factual source for all AI agents (Codex, Cursor, etc.).
- Each subdirectory with an `AGENTS.md` also has a `CLAUDE.md` containing only `@AGENTS.md` so Claude Code reads the same content.
- Per-package rules in subdirectory `AGENTS.md` take precedence over root rules where they conflict (most-specific wins).
- When picking up a task, read the root `AGENTS.md` first, then the AGENTS.md of the package(s) you'll touch.
- **Writing an ADR? Don't pick a number.** ADR ids are the **pull-request number** ([ADR-0037](docs/decisions/0037-adr-ids-are-the-pull-request-number.md), Rust-RFC style — this is what stops parallel agents in different worktrees from colliding on ADR numbers). Scaffold with `scripts/new-adr.sh "<title>"` (creates `docs/decisions/0000-<slug>.md`); once your PR is open, rename `0000-` to the PR number and fix the `# ADR-<n>:` header + the README index row. `pnpm docs:check` reds a forgotten rename or a duplicate number. Legacy ADRs `0001`–`0037` keep their old contiguous numbers; numbering is non-contiguous after that.

## Documentation conventions

- **Status banner.** Every handoff / plan / audit / archive doc under the repo root and `docs/` carries a banner whose first line starts `> **Status:** ` directly under its H1 (continuation lines allowed). The three templates — `current`, `historical — superseded by <link>`, `historical record — decisions still binding` — cover most cases; qualify freely (e.g. "current — only §2 remains open"). **Read the banner before trusting the content.** Canonical docs (`README.md`, `ARCHITECTURE.md`, `OPERATIONS.md`, `docs/TESTING.md`, this file) carry none — drift checks keep them current instead. Per-app `docs/` trees are encouraged but not required to follow this.
- **Placement.** Domain handoffs go to `docs/<domain>-handoff.md`; audits to `docs/audits/YYYY-MM-DD-<slug>.md` (one legacy file, `HANDOFF-cleanup-2026-06-04.md`, predates the naming rule); retired long-form narratives to `docs/archive/` — **except** the pre-existing phase docs (`docs/phase-*.md`) and `docs/plan/` runbooks, which deliberately stay in place per docs/audits/HANDOFF-cleanup-2026-06-04.md "Deliberate decisions" (banners, not moves, mark them historical — moving them breaks ~15 inbound links). The repo root keeps only `HANDOFF.md` plus the two pre-existing root handoffs. `HANDOFF.md` itself stays a short current-state document — production reality, open threads, operational log. Closeout-style records graduate to docs/archive/HANDOFF-phase-closeouts.md; don't let them re-accumulate in the root file (`docs:check` prints line counts and flags growth past 300 lines).
- **A migration that retires a term owns the doc sweep.** When a PR removes or renames a tool, directory, or domain name (e.g. Dokploy, `compose-dokploy/`), that PR must sweep *live* docs for the dead term in the same change, then either add the term to `scripts/check-doc-drift.sh`'s stale-pattern grep (only if it should appear **nowhere**, banners included) or rely on status banners for historical docs that legitimately mention it. The cautionary tale: the `compose-dokploy/` → `compose/` rename left runnable-but-wrong commands in live ops docs for a week because no step owned the sweep.
- **Verbatim records stay verbatim.** Audit records and similar quote-bearing history must not be edited to satisfy checkers — exempt the file instead (`SKIP_FILES` in `scripts/check-doc-links.py`, with a reason) or annotate around the quote.
- **zh-CN mirrors** (`README.zh-CN.md`, `ARCHITECTURE.zh-CN.md`, `OPERATIONS.zh-CN.md`) are hand-synced and may lag; the English file is canonical, and each mirror says so in its header. Update mirrors with the English file when convenient — never let the mirror be the only place a fact lives.

## Scan before you build: prefer mature implementations

Before hand-rolling a non-trivial module, **scan for a mature existing implementation and surface the build-vs-adopt tradeoff first** — name the leading options and why you'd pick or reject each, *before* generating a pile of bespoke code. The failure mode this prevents: build it custom, debug it piece by piece, then discover a library did it better all along. This is a judgment guideline, not a machine-enforced gate (you can't lint for "should have used a library").

**When it applies:** infrastructure-shaped work where mature solutions plausibly exist — chat/agent UIs, charts, rich text, PDF, date/timezone math, parsers, state machines, job queues, search, file upload, auth primitives, and the like.

**Apply it with the grain, not blindly:**

- **Commodity / horizontal concern → prefer the mature library.** Don't hand-maintain a chat composer or an SVG chart engine.
- **Domain / governance logic → keep it in-house.** Nothing off the shelf encodes our inventory rules, `safe-query`, approval gates, or numeric guardrails. Be skeptical of any framework that wants to *own* the agent loop, persistence, or a trust boundary — borrow its pattern, not its grip on the core.
- **"Existing" means the *blessed* existing stack** (e.g. shadcn/ui for components), not a new random dependency. Don't introduce a second component library to satisfy this rule (see `apps/backoffice-web/AGENTS.md` component rules).
- **Data-boundary still holds.** A mature option that ships our data to a third-party cloud (managed GenUI, hosted code-exec sandboxes) is not automatically "better" — Iron Law security wins.

**Doesn't apply to:** domain-specific business logic, trivial / glue code, or anywhere adopting the library would cross an Iron Law.

## Codex Session Startup

Read these before making changes:

- This `AGENTS.md`
- The AGENTS.md of any package you'll modify
- `README.md` for environment setup and quick-start commands
- `HANDOFF.md` for the latest deployment / on-call notes
- `docs/multi-location.md` if you'll touch store scoping — the `locationId`-vs-`merchantId` model, what shipped, and the intentionally-deferred work

## Development workflow

Before touching code:

1. `git pull --ff-only` on `main` (or rebase your branch onto fresh `main`). Don't start work on a stale tree — CI runs that disagree with `origin/main` waste self-hosted runner cycles.
2. `pnpm install` if `pnpm-lock.yaml` changed in the pull.
3. Read the `AGENTS.md` of the package(s) you'll touch (per [AI agent conventions](#ai-agent-conventions)).

Branch protection on `main`:

- Direct push is blocked. Open a PR even for one-line fixes.
- **Self-merge on green — don't ask.** The moment the required checks pass on your own PR, squash-merge it; do not wait for the user to confirm (green **is** the confirmation). Canonical command:
  ```bash
  gh pr merge <PR#> --admin --squash --delete-branch
  ```
  Agents without `gh` (e.g. Claude Code on the web) use the equivalent GitHub MCP merge (mark the PR ready first if it's a draft). **Exceptions — do NOT auto-merge when:** the user explicitly asked you to hold it / keep it a draft, it's flagged WIP, or it isn't your own PR. A merge never implies a deploy (deploys stay user-gated, above).
- This repo has one human owner/operator; "wait for review" is not a separate gate.
- **Dependabot PRs self-merge.** `.github/workflows/dependabot-auto-merge.yml` enables GitHub auto-merge (squash) on every Dependabot PR — all groups, including framework majors — so they land on `main` as soon as the required checks go green. This only reaches `main`, never prod (deploy stays user-gated); a bad bump is caught at the next manual deploy build and `main` is revertible. To narrow it (e.g. hold majors), add a `dependabot/fetch-metadata` filter to that workflow.

Self-hosted runner maintenance:

- Restart a runner without rebooting the Mac:
  ```bash
  launchctl kickstart -k gui/$(id -u)/actions.runner.example-org-restaurant-ops-platform.<runner-name>
  ```
- Check active runners: GitHub Settings → Actions → Runners, or the Mac Monitor menu bar app (which polls this repo's `/runners` endpoint).

Don't trigger `build-images.yml` from the dev workflow — that's a deploy gate (see [Deploy is user-gated](#deploy-is-user-gated)), not a verification step.

## Task tracking (GitHub Projects)

Work-in-flight lives in GitHub, not in repo docs: **Issues** say what to deliver, the single **`Example Kitchen · Development`** Project ([board](https://github.com/users/example-org/projects/1)) says where it stands, **PRs** prove it's done. There is deliberately no `STATUS.md` or other in-repo progress ledger — don't add a second source of truth. (`HANDOFF.md` stays production/ops reality; ADRs stay long-term decisions; this file stays the rules.)

**When an Issue is required:** anything that is product-behavior, multi-file, a migration, parallel-developed, or longer than ~30 min. A throwaway single-file fix can go straight to a PR — file the Issue retroactively only if it grows.

**Issue shape:** one deliverable — goal, acceptance criteria, explicit non-goals, whether it needs deploy, and any sub-tasks. A large feature is a **parent Issue** + **sub-issues** (`gh issue create --parent <n>`, needs gh ≥ 2.95) or phased PRs; the parent's sub-issue progress bar is the feature's % done.

**Project fields:** `Status` (Inbox → Backlog → Ready → In Progress → In Review → Blocked → Done), `Workstream` (business area), `Agent` (Codex / Claude / Human / Dependabot). Priority stays on the `P0`–`P3` labels; app labels stay the code-scope signal. New Issues/PRs auto-add at `Inbox`. Set fields via the GitHub MCP if connected, else `gh project item-edit`.

**Agent protocol — every agent, every session:**

1. **Pick up** → set `Agent` + `Status: In Progress`, assign yourself, and put the Issue number in the branch name (`claude/842-square-recipe-sync`).
2. **Open the PR** with `Closes #<leaf-issue>` in the description → the Issue moves to `In Review`.
3. **Blocked** → `Status: Blocked` + the reason; use a GitHub `blocked by` dependency; add the `needs-human` label if it needs an owner decision.
4. **Abandon** → return to `Ready` and clear `Agent` so another session can take it.
5. **Merge** (squash, per [Development workflow](#development-workflow)) auto-closes the Issue → `Done`. **`Done` ≠ deployed** — deploy stays [user-gated](#deploy-is-user-gated); if a merged Issue still needs shipping, leave or open a `deploy-required` item.

**WIP discipline:** one primary Issue per agent at a time; aim for ≤ 3–4 repo-wide `In Progress`. `scripts/sessions.sh` prints what each local worktree is doing (it reads an optional per-worktree `SESSION.md`) — a diagnostic only; the Project board, not that script, is the source of truth.

## Review Guidelines

When reviewing changes, prioritize findings that would create regressions, unsafe production behavior, or architectural drift:

- Treat any Iron Law violation as high severity.
- Flag handwritten contract / DTO changes that should come from `packages/contracts`.
- Flag cross-app database imports.
- Flag Floor vs Backoffice scope confusion (e.g. analytics widgets bolted onto board page).
- Flag analytics SQL written outside `apps/analytics-api/src/analytics/safe-query.ts` for free-form queries.
- Flag missing validation whenever a change touches a public API, package boundary, migration checkpoint, or runtime-critical workflow.
- Flag iPad-landscape regressions on `ios/` and on Floor web surfaces.
- Flag logging that uses `print` / `console.log` where structured logging is needed, or logs secrets, auth tokens, customer data, or raw payloads without justification.
- **Lethal trifecta (AI surfaces).** Flag any change that would let a single AI surface simultaneously hold all three legs: ① private-data access, ② untrusted-content intake (e.g. `web_search`, file / invoice OCR), and ③ external communication — an outbound-send tool, **or auto-loaded remote resources in rendered AI output** (markdown images, prefetched links). Prompt injection is unpatchable, so this is an architecture-permission constraint, not a model-guardrail one: treat completing the trifecta as high severity — split the capability, drop the third leg, or gate it behind explicit human confirmation. (Backoffice AI already has ① and ②; the rendered-output image channel was closed in `apps/backoffice-web/components/ai-elements/response.tsx`.)
- Flag refactors that quietly change behavior without calling that out, and migrations that do not define checkpoints, compatibility assumptions, or rollback considerations.
