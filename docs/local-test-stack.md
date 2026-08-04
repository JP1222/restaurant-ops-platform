# Local manual-test stack (own terminal, close-to-stop)

> How to bring up the local **manual-test stack** (all 5 apps + analytics by default) for clicking around in a browser, in a terminal window whose lifecycle owns the stack: **close the window → the whole stack stops.**

This is the "run the stack" job, not the "run the tests" job — see the distinction in [LOCAL-DEV-GUIDE.md §3](LOCAL-DEV-GUIDE.md) and the automated lanes in [TESTING.md](TESTING.md). For the canonical full 5-app launcher use `make dev`; this doc is the focused manual-test variant that lives in a window you control.

## The rule (why this exists)

When asked to "start local testing," the stack must run in **its own macOS Terminal window**, as that window's foreground process — **not** as a hidden/background job. Closing the window (macOS prompts to confirm killing the running process) signals the whole process group and tears down all dev servers. That keeps "stop testing" as simple as ⌘W, and means the stack never outlives the window or a tool session.

## What it starts

By default it starts the **full stack** — all 5 apps + analytics:

| Service | Role | URL | Auth |
| --- | --- | --- | --- |
| `inventory-api` | backend (single write-path for **both** UIs, Iron Law #4) | http://localhost:4100 | crew session cookie / internal bearer |
| `crew-web` | Floor frontend (line cooks, PIN) | http://localhost:3003 | PIN `123456` · `258025` · `777700` · `432109` |
| `backoffice-web` | Backoffice frontend (manager admin) | http://localhost:3001 | login `admin` / `admin` |
| `kds-api` | KDS backend (Clover sync, KDS state, WS fanout) | http://localhost:4000 | — |
| `kds-web` | KDS board / customer-display | http://localhost:3000 | — |
| `analytics-api` | Clover → Postgres OLAP (backoffice analytics dashboards read from it) | http://localhost:3100 | — |

Pass `lite` (aliases `min` / `core`) to start just the focused write-path + two UIs — `inventory-api` (:4100), `crew-web` (:3003) and `backoffice-web` (:3001). That's a faster boot for floor/backoffice manual testing when you don't need KDS or the **analytics dashboards** (those read from analytics-api; without it the pages show no data).

## How to launch it

The runner is [`scripts/dev-local-test.sh`](../scripts/dev-local-test.sh). To make it own a **new terminal window**, start it through `osascript` (run from the repo root):

```bash
osascript \
  -e 'tell application "Terminal"' \
  -e "  do script \"cd $PWD && ./scripts/dev-local-test.sh\"" \
  -e '  activate' \
  -e 'end tell'
```

> The no-arg form now launches the full 5-app + analytics stack. Use `... ./scripts/dev-local-test.sh lite` for the focused 3-service variant (inventory + crew + backoffice).
> The **first** time, macOS prompts "Terminal wants to control Terminal" (Automation permission) — approve it once.
> Only `Terminal.app` is assumed installed. For iTerm2, swap the AppleScript target to `"iTerm"` (its `create window with default profile … write text` API differs).

You can also just run `./scripts/dev-local-test.sh` directly in any terminal you already have open — that terminal then owns the stack the same way.

## What the runner does (idempotent, safe to re-run)

1. **Port guard** — aborts if any of the chosen stack's ports are already bound (`4100/3003/3001/4000/3000/3100` for full, the first three for `lite`), so you never double-launch on top of an earlier window or a leftover background task.
2. **Deps** — runs `pnpm install` **iff** this checkout has no `node_modules`. A **git worktree does not share the main checkout's `node_modules`**, so a fresh worktree needs its own install (fast off the warm pnpm store).
3. **Backing services** — `docker compose -f docker-compose.dev.yml up -d --wait` (the 3 Postgres + Redis), gated on healthchecks. These are *not* tied to the terminal — closing the window stops the apps but leaves the databases (and your data) running.
4. **Migrations** — `pnpm db:migrate:deploy` (kds + auth + inventory) before the apps boot. **This is the easy-to-miss one:** a database that's behind by a migration passes `/api/ready` (the connection works) but 500s on the first query that touches a missing table — e.g. `GET /api/inventory` → Prisma **P2021** `relation "public.inventory_item_aliases" does not exist`. Applying pending migrations first prevents that.
5. **Launch** — `exec turbo run dev … --continue` for the chosen apps, in the foreground.

## Stopping & restarting

- **Stop:** close the terminal window (confirm the kill prompt) or press `Ctrl-C` in it. Apps stop; Docker databases keep running.
- **Restart:** re-run the launch command — the port guard ensures a clean single instance.
- **Also stop the databases:** `make down` (keeps volumes/data) or `docker compose -f docker-compose.dev.yml down`.

## Testing against Clover (sandbox)

When the stack runs on the **Infisical `dev`** backend (the default once you're `infisical login`'d — see the footer), it is wired to the **Clover sandbox** merchant `QZPHD754XEXQ1`, not production. The runtime `CLOVER_*` vars the apps read are Infisical **secret references** to the stored sandbox creds, so there is one source of truth and nothing to copy by hand:

| Runtime var (apps read) | Infisical `dev` value | Resolves to |
| --- | --- | --- |
| `CLOVER_BASE_URL` | `https://apisandbox.dev.clover.com` | sandbox Platform v3 host |
| `CLOVER_ECOMM_API_BASE_URL` | `https://scl-sandbox.dev.clover.com` | sandbox Ecommerce host |
| `CLOVER_TOKEN` | `${CLOVER_SANDBOX_ACCESS_TOKEN}` | v3 access token |
| `CLOVER_MERCHANT_ID` | `${CLOVER_SANDBOX_MERCHANT_ID}` | `QZPHD754XEXQ1` |
| `CLOVER_ECOMM_PUBLIC_KEY` | `${CLOVER_SANDBOX_ECOMM_PUBLIC_KEY}` | iframe tokenization key |
| `CLOVER_ECOMM_PRIVATE_KEY` | `${CLOVER_SANDBOX_ECOMM_PRIVATE_KEY}` | server-side charge key |

`resolveDefaultCloverMerchantId` returns the **env** `CLOVER_MERCHANT_ID` when both it and `CLOVER_TOKEN` are set (`canBootstrapCloverMerchantFromEnv`), so the menu path needs **no `cloverMerchant` DB row** — the env is enough.

**Works out of the box** (verified):

- `GET http://localhost:4000/api/order/menu` serves the **real sandbox catalog** (the menu *is* Clover inventory, ADR-0027). Seed/refresh it with the idempotent [`scripts/seed-clover-sandbox-menu.mjs`](../scripts/seed-clover-sandbox-menu.mjs).
- `GET http://localhost:4000/api/ready` → `checks.cloverToken: "ok"` (startup probe hit `GET /v3/merchants/{id}` with the sandbox token).
- The Ecommerce charge path (tokenize on `token-sandbox…` + charge on `scl-sandbox…`) — use Clover's test card `4242 4242 4242 4242`.

**Needs more than env wiring** — a paid order showing up on the **local KDS board**. `/api/order/checkout` creates the Clover order, but it reaches the KDS via the `O:` **webhook**, which can't reach `localhost`. To close that loop locally, either (a) add a `cloverMerchant` row so the reconciliation poller pulls modified orders, or (b) expose `…/api/clover/webhooks` through a tunnel (cloudflared/ngrok) and set the URL in the Clover dashboard. See the verified API sequence in [clover-integration-recipe.md](design/online-ordering/clover-integration-recipe.md).

> The committed-dummy **`local`** backend (a fresh clone with no `infisical login`) has **no** Clover creds — `/api/order/menu` returns 503 there. Clover testing needs the Infisical `dev` backend.

## Relationship to the other commands

| Command | Job | Lifecycle |
| --- | --- | --- |
| `./scripts/dev-local-test.sh` (this) | manual-test: full stack (5 apps + analytics; `lite` for just crew + backoffice + inventory) in a window you close | owned by the terminal window |
| `make dev` | canonical full 6-app stack (kds-api, kds-web, inventory-api, analytics-api, backoffice-web, notifications-api) | foreground of the shell that ran it |
| `pnpm test` / `pnpm test:integration` | automated suites — own throwaway services, need none of the above running | self-contained, exits |

Secrets are injected by [`scripts/with-secrets.sh`](../scripts/with-secrets.sh) (committed dev defaults locally; Infisical when `SECRETS_BACKEND=infisical`) — the same seam `make dev` uses, so no `.env` on disk.
