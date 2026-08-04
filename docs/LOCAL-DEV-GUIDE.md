# LOCAL-DEV-GUIDE.md

> A teaching guide for setting up local development the way real teams do — using the restaurant-ops-platform monorepo as the running example.
> Written for a solo owner + one non-technical partner. You don't need to be a career engineer to follow this. Where something is a "rule of thumb the pros use," I'll say so and explain *why*.

---

## 0. Why this document exists

Right now, getting restaurant-ops-platform running on a fresh Mac is a treasure hunt. The README Quick Start is missing steps, one of the three databases is never created, the migration command only migrates *part* of the system, and there's a secret hand-built `curl` command to create the first user that nobody would ever guess. None of that is unusual for a project that grew organically — but it's exactly the friction that good local-dev practice is designed to delete.

This guide teaches you the *mental model* professionals use, walks the *ladder of tooling* from "a shell script" up to "cloud dev environments," and ends with a concrete recommended setup for **this** repo and **this** team. The goal isn't to make you an infrastructure expert. It's to make "bring up the whole stack" cost **zero thought**.

---

## 1. The core mental model: an environment should cost ~0 thought

Here's the single idea everything else hangs on:

> **`git clone` → one command → it's running on `localhost`.**

That's the bar. Not "clone, then read a wiki, then install five things in the right order, then hand-edit a config file, then run four commands, then discover you missed one." A new machine (or a teammate, or *you* in six months after you've forgotten everything) should be able to go from nothing to a working stack with **one** command they don't have to think about.

### Why this matters more than it looks

- **You are the future stranger.** The person most hurt by a fragile setup isn't a new hire — it's *you*, six months from now, on a new laptop, with a customer waiting. Every manual step is a thing you'll have forgotten.
- **A non-technical partner has zero tolerance for "incantations."** Your partner doesn't use a terminal. Every step that says "now edit this file and paste this token" is a step they simply *cannot* do. The closer you get to one command (and eventually one button), the more the system is usable by someone who isn't you.
- **Friction compounds.** A 30-minute setup you do once a quarter feels fine. But multiply it by "every time something breaks and you want a clean slate," and it becomes the reason you *avoid* resetting — which means you debug on a dirty environment, which wastes more time. Cheap reset → fearless reset.

### The two halves of "the litmus test"

A genuinely good bootstrap passes two tests:

1. **Fresh-laptop test:** runs on a machine that has *nothing* and ends with a working stack.
2. **Old-laptop test:** runs on a machine that already has a half-set-up version from months ago, and *converges* to the same working stack without erroring on "that already exists."

Test #2 is the one people forget, and it has a name: **idempotency**. An idempotent command can be run twice and the second run is safe — it checks before it acts. (`command -v` before installing, `[ -f ]` before creating, `CREATE DATABASE … IF NOT EXISTS`, `grep -qF … ||` before appending.) ([Arslan, *How to write idempotent Bash scripts*](https://arslan.io/2019/07/03/how-to-write-idempotent-bash-scripts/)) We'll lean on this hard, because a bootstrap you're afraid to re-run is barely better than no bootstrap.

### Separate "describe" from "do"

One more principle that keeps the mental model clean:

> **The README *describes*. The script *does*.**

Anything a human is told to copy-paste *in sequence* is a latent bug — it will drift, and someone will run step 3 before step 2. So the README's job shrinks to: prerequisites you genuinely can't auto-install (Docker Desktop, a runtime manager, the secrets CLI), the *single* command, the expected URLs/ports, and a troubleshooting list. Everything deterministic moves into the script. ([GitHub README guide, *Optimize local dev environments for onboarding*](https://github.com/readme/guides/developer-onboarding))

---

## 2. The ladder of approaches (and when each rung is worth it for a small team)

Reproducible environments are a **spectrum**, not a single choice. Each rung up buys you more determinism and costs you more setup time and team know-how. The skill is buying *only the rung you need*. ([James Ralph, *Nix vs Docker for reproducible dev*, 2025](https://www.james-ralph.com/posts/2025-10-04-nix-vs-docker-reproducible-dev.html); [GitHub README guide](https://github.com/readme/guides/developer-onboarding))

### Rung 1 — A bootstrap script + a task runner

The foundation. A single idempotent script (`scripts/bootstrap`) takes a fresh clone to a running stack, and a **task runner** gives every common action a memorable verb.

The key insight from GitHub's widely-copied "Scripts To Rule Them All" pattern: **standardize the *verb*, not the implementation.** ([github/scripts-to-rule-them-all](https://github.com/github/scripts-to-rule-them-all))

> "If your scripts are normalized by name across all of your projects, your contributors only need to know the pattern, not a deep knowledge of the application."

So you pick canonical verbs and never make anyone learn which app needs which incantation:

| Verb | Means |
| --- | --- |
| `bootstrap` / `setup` | From fresh clone (or reset) to ready-to-run |
| `up` | Start the stack |
| `down` | Stop the stack |
| `test` | Run the automated tests |
| `update` | After a `git pull`: re-install + re-migrate |

A **task runner** is the menu that surfaces those verbs. It is *not* a build system — modern guidance calls it "a glorified script launcher," and that's the point: its job is discoverability and hiding complexity behind a verb. ([Botmonster, *Just vs Make vs Task*](https://botmonster.com/self-hosting/just-vs-make-vs-task-modern-command-runner/))

**Worth it for a small team?** Always. This is the floor. Everything else is optional.

A quick tour of the runners real teams reach for in 2025–2026:

| Tool | Flavor | Why pick it | Watch-out |
| --- | --- | --- | --- |
| **pnpm/npm scripts** | `package.json` | Zero new tools; already in your repo | No `--list` with descriptions; clumsy for multi-line shell |
| **just** | Make-like, no tab traps | "Best general command runner for most new projects"; `just --list` is a self-documenting menu; recipes can be bash/python/node | Not a build system (fine — you don't want it to be) |
| **Task** | YAML (`Taskfile.yml`) | `includes:` for monorepos, native `--watch`, `desc:` fields auto-document | YAML gets verbose — a 3-line `just` recipe can balloon to 8 |
| **make** | Tab-significant | Ubiquitous | "Works on Linux may silently break on macOS" (GNU vs BSD); tab traps |
| **mise** | `mise.toml` | Combines **tool-version management + tasks** in one file | Monorepo task mode still experimental |

The common verdict in the sources: pick the one with the best *ergonomics*, because nobody's really using Make's file-dependency graph anymore. For a JS monorepo, **pnpm scripts** (already present) or a thin **`just`** menu on top are the two sane choices.

### Rung 2 — docker-compose (and the infra-vs-full distinction)

Containers make your *backing services* (Postgres, Redis) reproducible: same versions, same config, on every machine, started with one command. The dominant small-team pattern in 2025–2026 is:

> **Infra in Compose, your code on the host.**

You containerize the boring, durable dependencies (databases, cache) but run the code you edit 200×/day **natively on your Mac**, so you keep instant file-watch and hot reload. ([freeCodeCamp, *Docker Compose for Production Workloads*, 2025](https://www.freecodecamp.org/news/how-to-use-docker-compose-for-production-workloads/); [12factor.net/dev-prod-parity](https://12factor.net/dev-prod-parity))

There are two *modes* of compose, and naming them prevents confusion:

- **Infra-only compose** (what you want for daily dev): just Postgres + Redis. Apps run on the host. This is restaurant-ops-platform's current `docker-compose.dev.yml` stance.
- **Full-stack compose** (apps in containers too): useful for a one-shot "does the whole thing boot like production?" check, or for a teammate who shouldn't install Node at all. The cost is you lose native hot-reload (you need Compose's `develop.watch` file-sync, which doesn't work on slim images).

Modern Compose has a clean way to keep *one* file serve both: put infra services with **no `profiles`** and app services **behind a profile**, so `docker compose up` gives infra-only and `docker compose --profile full up` gives everything. ([freeCodeCamp](https://www.freecodecamp.org/news/how-to-use-docker-compose-for-production-workloads/))

**Two Compose patterns you must know:**

**(a) Gate on *readiness*, not *liveness*.** This is the #1 first-run flake.

> "Docker Compose does not wait until a container is 'ready', only until it's running."

A port being open is not the same as Postgres being able to answer a query. The fix is a `healthcheck` plus `depends_on: { condition: service_healthy }`, so dependents don't start until the check passes. ([Docker Docs, *Control startup and shutdown order*](https://docs.docker.com/compose/how-tos/startup-order/))

```yaml
db:
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U postgres"]
    interval: 5s
    timeout: 3s
    retries: 10
    start_period: 30s   # grace window so first-boot init isn't flagged "unhealthy"
```

(Note the `start_period`: without it, a fresh database that's still initializing gets falsely marked unhealthy. And the health-check tool — `pg_isready`, `redis-cli` — must actually exist in the image, or the check always fails. You've been bitten by a slim image missing `curl` before; same trap.)

**(b) Migrations are an *init step*, not the app's job.** The clean pattern is a dedicated one-shot `migrate` service that runs, applies migrations, and exits `0`; the apps then `depends_on` it with `condition: service_completed_successfully`. A non-zero exit *intentionally* blocks the stack from coming up on a broken migration. ([OneUptime, *Docker Compose Init Containers Pattern*, 2026](https://oneuptime.com/blog/post/2026-02-08-how-to-use-docker-compose-init-containers-pattern/view))

**Worth it for a small team?** Yes for infra — three Postgres + Redis with healthchecks is the right backbone here. *No* for putting your five apps in containers for daily dev; you'd lose hot-reload for a parity payoff you don't need at this size.

### Rung 3 — Dev Containers / Codespaces

A `devcontainer.json` describes the *entire* environment as code — OS libs, tools, even editor extensions — so VS Code (locally) or GitHub Codespaces (in the cloud) can clone, provision, and open a ready workspace with no manual steps. ([containers.dev/features](https://containers.dev/features))

The thing to internalize is the **cost split**:

- The **`devcontainer.json` file** is cheap and valuable. Adding one is low-risk; it's just a recipe.
- **Codespaces *compute*** is the part that adds up. Personal accounts get a free tier (~120 core-hours/month + 15 GB storage), but **organizations get *no* free quota — it's pay-as-you-go from minute one** ($0.18/core-hour + $0.07/GB-month). ([github.com/pricing](https://github.com/pricing); [GitHub Docs, *About billing for Codespaces*](https://docs.github.com/billing/managing-billing-for-github-codespaces/about-billing-for-github-codespaces))

Why this rung is attractive *specifically for your team*: it's the cleanest path to giving your **non-technical partner a one-click "Open in Codespaces"** button — no CLI, no SSH, no Docker install. That's their stated constraint, and this directly answers it. The trade is metered compute.

**Worth it for a small team?** The `devcontainer.json` — yes, eventually; it's cheap insurance and a partner on-ramp. Paid Codespaces compute — only when local setup genuinely stops scaling or the partner truly needs an in-browser environment.

### Rung 4 — Reproducible toolchains (pin the tools, not just the libs)

"Works on my machine" is, nine times out of ten, a *version drift* problem: your Mac has Node 22 and pnpm 10, CI has Node 20, and something subtly breaks. A toolchain manager fixes the *language and tool versions* from a checked-in file so every machine + CI agree.

The ladder *within* this rung:

| Tool | Pins | UX | When |
| --- | --- | --- | --- |
| **asdf / mise** | Tool versions (Node, pnpm, …) via `.tool-versions` / `mise.toml` | Simple | The 80% answer. **mise** also does env vars + tasks, so it can replace your task runner too. ([mise.jdx.dev](https://mise.jdx.dev/)) |
| **Dev Containers** | Tools + OS libs (ephemeral) | Medium | When OS-level deps differ across machines |
| **devbox** | Nix store, npm-like UX | Medium | Nix benefits without Nix expertise ([DevToolReviews 2026](https://www.devtoolreviews.com/reviews/devbox-vs-dev-containers-vs-nix-2026)) |
| **Nix flakes** | Bit-for-bit everything | Hard | Strongest reproducibility; a working flake "took over an hour the first time" ([James Ralph](https://www.james-ralph.com/posts/2025-10-04-nix-vs-docker-reproducible-dev.html)) |

**Worth it for a small team?** Pin with **mise or asdf** — high value, low cost, and it kills a whole class of first-run pain. Skip devbox/Nix unless you later want bit-for-bit parity with your ARM production box (overkill at two people).

### Rung 5 — Remote / cloud environments

The top of the ladder: the environment doesn't live on your laptop at all. Codespaces (above) is one form; Gitpod is another. Duolingo, for example, reports it "takes just one minute to spin up a monolith Codespace that's practically equivalent to a local environment." ([GitHub README guide, *Simplifying onboarding (Duolingo)*](https://github.com/readme/guides/github-codespaces-duolingo))

**Worth it for a small team?** Not as your daily driver yet. It's the rung you reach for *if* local bootstrap stops scaling, or *if* you want a zero-install button for the partner. File it under "known next step," not "do now."

### The ladder, summarized

```
Rung 1  bootstrap script + task runner   ← ALWAYS. The floor.
Rung 2  docker-compose (infra-only)       ← YES for DB/Redis. Apps stay on host.
Rung 3  Dev Container file                ← Add the file; defer paid Codespaces.
Rung 4  mise/asdf toolchain pin           ← YES. Cheap, kills version drift.
Rung 5  remote/cloud envs                 ← Later, if/when needed.
```

---

## 3. The single most important idea: separate "run the stack" from "run the tests"

If you take one thing from this guide, take this. These are **two different jobs with two different lifecycles**, and conflating them is the most common onboarding smell there is.

| | "Run the stack" (click around) | "Run the tests" (automated) |
| --- | --- | --- |
| **Purpose** | A human pokes the live app in a browser | CI / you verify correctness, unattended |
| **Data** | Persistent, realistic demo data you build up | Ephemeral, deterministic, thrown away every run |
| **Services** | Long-running, real ports (3000/3001/4000/…) | Isolated, random ports, gone when done |
| **Tool** | **docker-compose** (bring it up once) | **Testcontainers** (each suite owns its services) |
| **Command** | `up` / `dev` | `test` |

GitHub's STRTA codifies this as distinct `script/server` vs `script/test`. ([github/scripts-to-rule-them-all](https://github.com/github/scripts-to-rule-them-all)) The two are **complementary, not competing** — but they must never be the *same command*. ([terminal7, *Testcontainers or Compose*](https://terminal7.dev/posts/testcontainers_or_compose/); [getautonoma, *Docker Compose testing*](https://getautonoma.com/blog/docker-compose-testing))

### Why conflating them hurts

- **Data pollution.** If tests run against your dev database, a test that creates or wipes rows silently corrupts the demo data you were clicking through.
- **Port clashes.** "Why is port 3000 taken?" — because the test run and the dev stack both grabbed it.
- **Hidden coupling.** If `pnpm test` only works *after* you've manually run `docker compose up` and applied migrations, it isn't really a test command — it's a manual procedure wearing a test command's clothes.

### The fix: make `pnpm test` self-contained with Testcontainers

The defining property of a good test suite is that **it provisions its own dependencies and tears them down** — it never assumes a human pre-started anything. **Testcontainers** is the library that makes this true: from *inside* your test code, it spins up real Postgres/Redis as disposable Docker containers, on dynamically-mapped ports (so no conflicts), and cleans them up automatically. ([node.testcontainers.org — PostgreSQL module](https://node.testcontainers.org/modules/postgresql/))

```ts
import { PostgreSqlContainer } from "@testcontainers/postgresql";

const pg = await new PostgreSqlContainer("postgres:16-alpine")
  .withDatabase("app_test").withUsername("test").withPassword("test")
  .start();

const url = pg.getConnectionUri();   // a real DATABASE_URL for Prisma/your app
// ... run migrations against `url`, then run tests ...
await pg.stop();
```

Why real containers instead of mocks? Because the bugs that bite live in the *interaction* between your code and the actual database engine — constraints, cascades, transactions, SQL dialect quirks. Mocks "miss real behavior." ([OneUptime, *Node.js Integration Tests with Testcontainers*, 2026](https://oneuptime.com/blog/post/2026-01-06-nodejs-integration-tests-testcontainers/view); [Microsoft Learn, *Testing against your production DB system*](https://learn.microsoft.com/en-us/ef/core/testing/testing-with-the-database))

**A few patterns the pros use** (so the suite is fast *and* isolated):

- **Start the container once per suite, not per test.** Container startup is the expensive part. In Vitest you do this with `globalSetup`, then hand the connection string to every test file via `provide`/`inject` (or by setting `process.env.DATABASE_URL`). ([Vitest, *globalSetup*](https://vitest.dev/config/globalsetup); [node.testcontainers.org, *Global setup*](https://node.testcontainers.org/quickstart/global-setup/))
- **Isolate between tests cheaply.** Start with `TRUNCATE … RESTART IDENTITY CASCADE` in `beforeEach` (simple, robust). If you outgrow it, move to **database-per-worker** keyed on `VITEST_POOL_ID` for true parallelism, with Postgres data on `tmpfs` for speed. ([OneUptime](https://oneuptime.com/blog/post/2026-01-06-nodejs-integration-tests-testcontainers/view); [Zenn, *Parallel DB tests with Vitest + Testcontainers*](https://zenn.dev/onozaty/articles/vitest-testcontainer-prisma?locale=en))
- **Prefer factories over shared seed data.** Shared seed rows are a coupling trap — editing one row for a new test breaks unrelated tests, and one test's insert can violate another's uniqueness constraint. Build exactly the data each test needs, inline. (A little *reference* seed — lookup tables, enums — baked into the migrated schema is fine.) ([Los Techies, *Strategies for isolating the database in tests*](https://lostechies.com/jimmybogard/2013/06/18/strategies-for-isolating-the-database-in-tests/))
- **For end-to-end (Playwright): log in once.** Authenticating inside every spec is slow and flaky. Use a **setup project** that logs in once, saves `storageState` to a JSON file, and have every other project consume it via `dependencies: ['setup']`. Gitignore that file — it holds live session cookies. ([Playwright docs, *Authentication*](https://playwright.dev/docs/auth))

The payoff: `pnpm test` becomes a single command that needs **none** of your five dev apps running and **zero** `docker compose up` beforehand. That's the bar.

### What shipped here (the pattern to copy)

Phase 2 (ADR-0026) implemented this. Two lanes, two commands:

```bash
pnpm test               # unit — mocked, fast, NO Docker (the inner loop). Also: make test
pnpm test:integration   # integration — real ephemeral Postgres/Redis. Also: make test-integration
```

Shared container helpers live in **`test/containers/`** (`startPostgres`, `startRedis`,
`deployPrismaMigrations`, `runPackageScript`, `truncateAll`/`prismaSqlRunner`,
`assertDockerAvailable`). Each app/package adds three things — a `vitest.integration.config.ts`,
a `tests/integration/fixture.ts` (composition), and a `*.integration.test.ts` — and adds
`tests/integration/**` to its default `vitest.config.ts` `exclude` so the unit lane never touches
Docker. A `test:integration` script (`vitest run --config vitest.integration.config.ts`) is wired
into the turbo `test:integration` task.

The fixture owns the lifecycle in `beforeAll`/`afterAll` (see `apps/inventory-api/tests/integration/`):

```ts
// fixture.ts — boot a throwaway DB, migrate it, wire the REAL app to it
export async function startInventoryItContext() {
  const pg = await startPostgres();                                  // disposable postgres:16-alpine
  await deployPrismaMigrations("db-inventory", pg.url);              // real `prisma migrate deploy`
  await runPackageScript("db-inventory", "seed", { INVENTORY_DATABASE_URL: pg.url });
  const prisma = createPrismaClient(pg.url);
  const app = await buildApp({ config: testConfig(pg.url), prisma }); // inject the container URL
  return { app, prisma, truncate: () => truncateAll(prismaSqlRunner(prisma)),
           stop: async () => { await app.close(); await pg.stop(); } };
}
```
```ts
// *.integration.test.ts — exercise the REAL routes over the REAL database
beforeAll(async () => { ctx = await startInventoryItContext(); });
afterAll(async () => { await ctx.stop(); });
it("toggle-86 persists", async () => {
  const res = await ctx.app.inject({ method: "POST", url: `/api/inventory/items/${id}/toggle-86`,
    payload: { confirm: true } });
  expect(res.statusCode).toBe(200);
});
```

Two deliberate departures from the generic advice above, both for robustness on a small codebase:

- **Fixture-in-`beforeAll`, not `globalSetup`+`provide`/`inject`.** With one integration file per app
  the container count is identical, and owning the lifecycle in the file sidesteps Vitest worker
  serialization *and* the apps' eager-module-load env coupling (every DB seam takes the URL as an
  argument — `createPrismaClient(url)`, `buildApp(services)`, `createPool(config)` — so nothing reads
  ambient `process.env`). `globalSetup`+`provide` and DB-per-worker remain the documented scaling path.
- **Hermetic, no ambient secrets.** Tests construct explicit config and pass the container URL in; CI
  needs only `TESTCONTAINERS_RYUK_DISABLED=true` (the reaper sidecar can't reach the daemon on the
  self-hosted mac runners — ADR-0008), with each fixture's `afterAll` doing the teardown.

> **Speed note:** the dominant per-suite cost for the Prisma apps is the `pnpm exec prisma migrate
> deploy` *subprocess spawn* (~3-5s), not the container. The raw-SQL analytics suite, which migrates
> in-process, runs in ~4s. If suite count grows, migrate once into a **template DB** and use
> `PostgreSqlContainer.snapshot()`/`restoreSnapshot()` per test.

---

## 4. Secrets in dev: Infisical's runtime injection (and why no `.env` on disk is a feature)

> Your team has already chosen **Infisical**, and a separate effort is wiring its exact mechanics. This section is about the *seam* — the shape of where secrets plug in — not Infisical's internals.

### The principle (it's 12-Factor, modernized)

The 12-Factor "Config" rule says configuration that varies between environments — database URLs, credentials, cross-service tokens — must live in **the environment**, separated from code, never committed. ([12factor.net/config — lineage via dotenvx](https://dotenvx.com/blog/2025/04/19/dotenvx-vs-docker-compose-secrets.html)) The classic way to do that locally was a `.env` file. The modern upgrade keeps the contract but **deletes the file**: the secret lives in a vault and is injected straight into the process at launch.

```bash
# Instead of reading a .env file on disk:
infisical run --env=dev -- pnpm dev:all
```

The app still just reads `process.env` — **nothing in your application code changes.** The only thing that changes is the *launcher*. ([Infisical, *run command*](https://infisical.com/docs/cli/commands/run))

### Why "no `.env` on disk" is genuinely better

This isn't dogma — there are concrete reasons:

> "The secrets live in memory, are fetched on demand, scoped to a single process, and disappear when that process exits." ([Infisical, *run*](https://infisical.com/docs/cli/commands/run))

- **A file is a leak waiting to happen.** `.env` files get accidentally committed, copied into Slack, left in backups. A value that only ever lives in process memory can't be any of those.
- **Your AI coding agents read files.** This one is directly relevant — you run Claude Code / Codex against this repo. AI agents traverse the whole tree to build context and **do not respect `.gitignore`**, so they *will* read a plaintext `.env` and could ship its contents to an external server. They **cannot** read the environment variables of a running process. Runtime injection closes exactly that hole. ([Infisical, *Your AI Coding Agent is Reading Your .env File*](https://infisical.com/blog/your-ai-coding-agent-is-reading-your-env-file))
- **One source of truth kills drift.** restaurant-ops-platform has ~20 hand-wired env vars, including bearer tokens that must *match* across kds-api and the backoffice BFF. When those live in one vault and are injected into every app, they match **by construction** — you can't fat-finger one copy out of sync.

### The non-technical-partner angle

Infisical has a **web dashboard** with role-based access: your partner gets a browser UI to view (and, if you allow, rotate) secrets — **no CLI required** — while you keep the admin role. That's the right surface for someone who doesn't touch a terminal. (Mechanics owned by the other effort; the point here is the *capability* exists.)

### Keep the seam pluggable (this is the important design move)

`infisical run -- <cmd>` is just a thin wrapper that means "set these env vars, then exec this command." Every comparable tool has the identical shape (`op run --`, `doppler run --`, `dotenvx run --`). So you should **wrap the injection behind one indirection** rather than hard-coding `infisical` into every script:

```bash
# scripts/with-secrets.sh  (conceptual)
# Default to Infisical; fall back to a local .env when it's absent or you opt out.
if command -v infisical >/dev/null && [ "${SECRETS_BACKEND:-infisical}" = "infisical" ]; then
  exec infisical run --env="${ENV:-dev}" -- "$@"
else
  exec node --env-file-if-exists=.env -- "$@"   # offline / no-Infisical fallback
fi
```

Two reasons this matters here:

1. **Offline resilience.** Infisical has no reliable offline cache today — if the vault or your Wi-Fi is down, `infisical run` can block your whole dev stack. ([Infisical issue #2496](https://github.com/Infisical/infisical/issues/2496)) A `.env`/`dotenvx` fallback means a plane-mode day isn't a dead day.
2. **CI and tests shouldn't pull real secrets.** Which leads to the crucial rule below.

### Tests live *outside* the secrets seam

Your automated tests should run **without** `infisical run`. Why? Because (per Section 3) Testcontainers **generates** its own database credentials at runtime — random ports, random passwords from `getConnectionUri()`. Test databases need no vault at all. And the cross-app bearer tokens that are fragile in dev become simple **fixtures** in test setup (one constant, injected into both the issuing and verifying app). So the secrets seam wraps only the *dev stack*; the *test* path stays hermetic and offline-safe. (Keep your one E2E `DATABASE_URL` a syntactically-valid **dummy**, not a real secret — Next builds the Prisma client at module-load before specs can stub it.)

---

## 5. What a great <10-minute onboarding looks like

Here's the experience you're aiming for. A teammate (or future-you) opens the repo and the README says, in essence:

> **Prerequisites** (the few things we *can't* install for you):
> 1. Docker Desktop (running)
> 2. mise (`brew install mise`) — pins Node + pnpm for you
> 3. Infisical CLI + `infisical login` — *or* set `SECRETS_BACKEND=local` to use a `.env`
>
> **Then run one command:**
> ```bash
> infisical run --env=dev -- ./scripts/bootstrap && infisical run --env=dev -- pnpm dev:all
> ```
>
> **Open:**
> | URL | What |
> | --- | --- |
> | http://localhost:3000 | KDS board (Floor) |
> | http://localhost:3001 | Backoffice (admin) |
> | http://localhost:4000 | kds-api |
> | http://localhost:4100 | inventory-api |
> | http://localhost:3100/health | analytics-api health |
>
> **Stuck?** DB didn't come up → `docker compose ps`. Imports fail → re-run bootstrap (it rebuilds libs). Analytics 500 on boot → the analytics DB is missing; re-run bootstrap.

Behind that one command, `scripts/bootstrap` does — **idempotently**, safe to re-run — everything that's currently manual or missing:

1. **Ensure tooling + install:** `pnpm install` (mise has already pinned Node/pnpm).
2. **Start infra and *wait*:** `docker compose -f docker-compose.dev.yml up -d --wait` — the `--wait` flag blocks until every healthcheck passes, so nothing races the databases. ([Docker Docs](https://docs.docker.com/compose/how-tos/startup-order/))
3. **Generate clients + build libraries *first*:** `pnpm db:generate && turbo run build --filter='./packages/*'` — because the `tsx` apps import the libraries' compiled `dist/`, this *must* happen before the apps start (more on this in Section 6).
4. **Apply *all* migrations:** kds **+ auth + inventory** (today's command silently skips auth and inventory), with analytics self-migrating on boot once its DB exists.
5. **Seed the first admin** via the bearer endpoint — guarded so a re-run is a no-op (check "does an admin already exist?" first).
6. **Print the URLs** and "what good looks like."

The maintenance ritual that *keeps* it under 10 minutes is famous and worth adopting literally:

> Ask someone who hasn't set up the project recently to follow the README on a fresh machine. **Every place they get stuck is a documentation (or script) gap.** Fix it on the spot. ([GitHub README guide](https://github.com/readme/guides/developer-onboarding))

For you, the perfect tester is your **non-technical partner** (or a clean VM). If they can't get to `localhost:3000`, the bootstrap isn't done yet.

---

## 6. What "good" looks like for YOU specifically

This is the concrete target for *this* repo and *this* team — a solo owner + one non-technical partner, on Mac, deploying plain `docker compose` stacks over SSH to an Oracle ARM VM. Everything below is grounded in what's actually in the tree today.

> **Status: landed.** This section is the original design *rationale*. It shipped as the `make` verbs — `make dev-up` / `make dev` / `make admin` under the `scripts/with-secrets.sh` seam (see §3 and §5 above). The script names below (`dev:all`, `compose:up`, `db:migrate:dev`) describe the *pre-refactor* root `package.json` scripts, now **removed** — read them as the problem statement and the plan that replaced them, not as commands to run.

### The five first-run gaps in this repo (verified, not guessed)

These are real, and your target setup exists to close them:

1. **There's no one-command bootstrap.** `scripts/` has ad-hoc dev launchers but **no `bootstrap`/`up`** that takes a fresh clone to a running stack. The root `package.json` *has* a `bootstrap` script, but it only runs `pnpm install` — it doesn't start Compose, generate clients, build libs, migrate, or seed.

2. **`db:migrate:dev` only migrates KDS.** The script is literally `pnpm --filter @rop/db-kds migrate`. **Auth and inventory are skipped.** Auth is especially sneaky: by ADR-0015 it's a *separate* Prisma package (`db-auth`) that happens to share KDS's physical Postgres, so its migrations *can't* ride along — they must be invoked explicitly, and nothing does. Result: a fresh KDS database has no `web_admin_accounts` table, so login fails.

3. **The analytics database is never created.** `docker-compose.dev.yml` starts exactly two Postgres containers (`rop_kds` :5432, `rop_inventory` :5433) + Redis. But `analytics-api` expects `rop_intelligence_dev`, and its raw-SQL migrator runs **on boot** against a database **nothing creates**. (Its on-boot migrator is actually a *good* example — sorted `NNN_*.sql`, a `schema_migrations` ledger, a `pg_advisory_lock` against concurrent boots. It just needs a database to point at.)

4. **Libraries must be built before the apps can import them.** `kds-api`, `inventory-api`, and `analytics-api` run via `tsx` and import `@rop/*` workspace packages whose `package.json` points at `./dist/index.js`. On a fresh clone, `dist/` doesn't exist yet → `ERR_MODULE_NOT_FOUND` the moment `tsx` evaluates the import. And the trap is doubly hidden because:
   - `turbo.json`'s **`dev` task has no `dependsOn`** (only `cache:false, persistent:true`), so Turbo won't build libs before dev, and
   - `dev:all` is a raw `pnpm --parallel … dev` that **bypasses Turbo's task graph entirely**, so even a correct `^build` wouldn't fire.

   > Heads-up the sources flag: `turbo watch build dev` alone does **not** reliably fix this — there's a known race where a persistent `dev` can start before its dependency's first build finishes ([vercel/turborepo #8673](https://github.com/vercel/turborepo/issues/8673)). The robust fix is an explicit one-shot build in bootstrap *and* a `dependsOn` on the `dev` task.

   > **Now addressed — dev resolves package *source*.** Each `@rop/*` package adds a custom `yr-src` export condition (`→ ./src/index.ts`), and the four tsx backends run with `NODE_OPTIONS='--conditions=yr-src'`. So in dev they import package **source** directly: editing a shared package (`contracts`, `db-*`, `auth`) **hot-reloads the backend live** (tsx watch follows the src into the import graph), and they no longer need `dist` to start. The condition is custom, so nothing auto-applies it — `pnpm build`, tests, and prod pass no condition and provably still resolve `dist`. (**Now closed for the Next web apps too.** Turbopack has no custom-condition knob ([vercel/next.js#78912](https://github.com/vercel/next.js/discussions/78912) is open), so the frontends reach package **source** via an env-gated `turbopack.resolveAlias` derived from `config/yr-src-map.mjs` — active only when the dev script sets `YR_SRC=1`. `next build` / tests / prod omit the flag and keep resolving `dist`. `pnpm docs:check` enforces the wiring across every backend and frontend so it can't drift.)

5. **The first admin is a hand-built bearer `curl`.** kds-api creates the first admin via a `POST` guarded by the `KDS_INTERNAL_ADMIN_TOKEN` bearer. Fine for you; impossible for your partner; undiscoverable from the README. It belongs *in* the bootstrap, guarded for idempotency.

### Your recommended target setup

**Tooling floor — `mise` + pnpm scripts.**
Add a `mise.toml` to pin Node + pnpm 10 (kills version drift), and keep your task verbs in `package.json` (you already standardize `compose:up`, `db:generate`, `dev:all`). Optionally lay a thin **`justfile`** on top as a self-documenting menu (`just`, `just up`, `just dev`, `just seed-admin`) — each recipe just delegating to the pnpm scripts. Turborepo stays the build engine underneath. The partner ultimately shouldn't touch any of these; the menu is for *you*.

**Infra — one `docker-compose.dev.yml`, three Postgres + Redis.**
Add the missing **`postgres-analytics`** service (e.g. `127.0.0.1:5434:5432`, db `rop_intelligence_dev`, own healthcheck + named volume) so analytics has a real home and its on-boot migrator just works — and the "analytics owns its own DB" Iron Law becomes physically true, not just logically. Keep healthchecks on all three (they're already there for the first two). Collapse the stray untracked `docker-compose.localdev.yml` (the +10-port fork that dodges a sibling checkout) into the main file using a **`.env`-driven port offset** (`${PG_KDS_PORT:-5432}`) so "avoid the other checkout's ports" is a variable, not a forked file.

**The one-command bootstrap (the centerpiece).**
Create `scripts/bootstrap` — idempotent, re-runnable — that does, in order:

```
pnpm install
  → docker compose -f docker-compose.dev.yml up -d --wait        # 3 Postgres + Redis, gated on health
  → pnpm db:generate                                             # all 3 Prisma clients
  → turbo run build --filter='./packages/*'                      # build libs BEFORE tsx apps import dist/
  → db:migrate:dev  (FANNED OUT: kds + auth + inventory)         # fix the partial-migrate gap
  → (analytics self-migrates on boot, now that its DB exists)
  → seed first admin via bearer endpoint, guarded (no-op on re-run)
  → print URLs + "what good looks like"
```

And fix the two underlying script bugs so the gaps can't reappear:
- Make `db:migrate:dev` a fan-out: `… db-kds migrate && … db-auth migrate && … db-inventory migrate`.
- Give `turbo.json`'s `dev` task `"dependsOn": ["^build", "generate"]`, **and** switch `dev:all` from raw `pnpm --parallel` to `turbo run dev …` so the dependency is actually honored. (Add `migrate:deploy` + `seed` scripts to `db-kds`/`db-auth` so they reach parity with `db-inventory`, which is your lifecycle reference — it even validates seed data against the zod contract before writing.)

**Secrets — wrap the outer command in the Infisical seam, pluggably.**
The dev entrypoint is `infisical run --env=dev -- ./scripts/bootstrap` (and `… -- pnpm dev:all`), so the ~20 env vars + matched bearer tokens are injected at runtime with **no `.env` on disk**. Put that behind `scripts/with-secrets.sh` with a `.env`/`dotenvx` fallback (`SECRETS_BACKEND=local`) for offline days and for anyone without the CLI. App code keeps reading `process.env` — no source changes. The partner uses the Infisical **web UI**; you (and CI) use a machine identity. *(Exact Infisical wiring is the other effort's job — you're just placing the seam at the command boundary.)*

**Tests — separate, self-contained, hermetic.**
Add `@testcontainers/postgresql`. Give each app a Vitest `globalSetup` that spins up its own ephemeral Postgres (kds+auth share one container and run *both* migration sets into it — which finally exercises the auth migrations the dev script skips; inventory and analytics each get their own), runs the right migrations, and injects `DATABASE_URL`. Isolate with `TRUNCATE … RESTART IDENTITY CASCADE` per test to start. For Playwright on backoffice-web, use the `storageState` setup-project pattern and create the first admin *through* the bearer endpoint as test infrastructure. Result: **`pnpm test` needs none of the five apps running and no `compose:up`** — and it runs *outside* `infisical run`, so it never depends on the vault. Keep `dev:all` (real infra, real ports) and `pnpm test` as clearly separate verbs.

**Defer (deliberately):** putting the five apps in containers for daily dev (you'd lose hot-reload), paid Codespaces compute, and Nix/devbox. Add a `devcontainer.json` *only* when you want the partner's one-click in-browser button — the file is cheap; the compute is metered.

### The finish line, restated

When this is done, the entire onboarding is:

```bash
# one-time prereq: Docker Desktop
make dev-up    # the landed one-command bootstrap (install + DBs + migrate + seed + admin)
make dev       # launch the stack
# → open http://localhost:3000 and http://localhost:3001
# (Infisical is opt-in: `SECRETS_BACKEND=infisical make dev`; committed dev-defaults are the default.)
```

…and verification is a separate, self-contained:

```bash
pnpm test
```

One command to *run it*. A different command to *test it*. No `.env` on disk. No hidden `curl`. No "which database didn't get migrated." That's what good looks like — and for a two-person team where one person doesn't use a terminal, it's not gold-plating; it's the difference between a system only you can operate and a system that operates itself.