#!/usr/bin/env bash
# scripts/dev-local-test.sh — launch the local MANUAL-TEST stack in the FOREGROUND
# of whatever terminal runs it, so that terminal OWNS the stack's lifecycle:
# close the window (or Ctrl-C) and every dev server dies with it.
#
# This is the "click around in a browser" stack (see docs/local-test-stack.md and
# LOCAL-DEV-GUIDE.md §3), NOT the automated suite (`pnpm test`). Default = the
# FULL stack (all 5 apps + analytics):
#
#     inventory-api   backend   http://localhost:4100   (one write-path, both UIs)
#     crew-web        frontend  http://localhost:3003   (PIN: 123456 / 258025 / 777700 / 432109)
#     backoffice-web  frontend  http://localhost:3001   (login: admin / admin)
#     kds-api         backend   http://localhost:4000
#     kds-web         frontend  http://localhost:3000
#     analytics-api   backend   http://localhost:3100   (backoffice analytics dashboards read from it)
#
# Pass `lite` as the first arg for just the focused write-path + two UIs
# (inventory-api + crew-web + backoffice-web) — a faster boot when you don't
# need KDS or the analytics dashboards. (`full` is still accepted; it is now
# the default.)
#
# Idempotent + robust on a fresh clone OR a git worktree (which has no
# node_modules of its own): it installs deps if missing, brings backing services
# up, and applies pending DB migrations BEFORE booting the apps — a
# behind-by-a-migration database is exactly why GET /api/inventory 500s on a
# stale checkout (Prisma P2021 "relation does not exist").
#
# `make dev` is still the canonical 5-app launcher; this script exists so the
# focused manual-test stack runs in a window you can close.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

say() { printf '\033[36m[dev-local-test]\033[0m %s\n' "$*"; }

# --- which apps -------------------------------------------------------------
# Default is the FULL stack (all 5 apps + analytics). Pass `lite` for just the
# focused write-path + two UIs. Any unrecognized arg falls through to FULL, and
# `full` is still accepted for backwards compatibility.
case "${1:-}" in
  lite|min|core)
    FILTERS=(--filter=@rop/inventory-api --filter=@rop/crew-web \
             --filter=@rop/backoffice-web)
    PORTS=(4100 3003 3001)
    say "stack: LITE — inventory-api + crew-web + backoffice-web  (omit 'lite' for all 5 + analytics)"
    ;;
  *)
    FILTERS=(--filter=@rop/inventory-api --filter=@rop/crew-web \
             --filter=@rop/backoffice-web --filter=@rop/kds-api \
             --filter=@rop/kds-web --filter=@rop/analytics-api)
    PORTS=(4100 3003 3001 4000 3000 3100)
    say "stack: FULL (5 apps + analytics)  (pass 'lite' for just inventory + crew + backoffice)"
    ;;
esac

# --- 0. refuse if a stack is already holding these ports --------------------
busy=()
for p in "${PORTS[@]}"; do
  if lsof -ti "tcp:$p" >/dev/null 2>&1; then busy+=("$p"); fi
done
if [ "${#busy[@]}" -gt 0 ]; then
  say "ports already in use: ${busy[*]}"
  say "another stack is running (an earlier terminal, or a Claude background task)."
  say "stop that one first, then re-run. Aborting so we don't double-bind."
  exit 1
fi

# --- 1. deps — git worktrees do NOT share the main checkout's node_modules ---
if [ ! -x node_modules/.bin/turbo ]; then
  say "no node_modules in this checkout — running pnpm install (warm store, quick)…"
  pnpm install --prefer-offline
fi

# --- 2. backing services (all Postgres DBs + Redis), gated on healthchecks ---
if command -v docker >/dev/null 2>&1; then
  say "ensuring backing services are up (docker compose --wait)…"
  docker compose -f docker-compose.dev.yml up -d --wait
else
  say "docker CLI not found — assuming backing services are already reachable."
fi

# --- 3. apply pending migrations (kds + auth + inventory), idempotent --------
say "applying any pending DB migrations…"
./scripts/with-secrets.sh -- pnpm db:migrate:deploy

# --- 4. launch the apps in the FOREGROUND (this terminal owns them) ---------
say "starting dev servers on ports: ${PORTS[*]}"
say "login: backoffice = admin / admin   crew PIN = 123456"
say "CLOSE THIS WINDOW (or press Ctrl-C) to stop the whole stack."
exec ./scripts/with-secrets.sh -- pnpm exec turbo run dev --env-mode=loose --continue "${FILTERS[@]}"
