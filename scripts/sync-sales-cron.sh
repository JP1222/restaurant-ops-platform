#!/usr/bin/env bash
# sync-sales-cron.sh — cron entrypoint for sales-driven inventory depletion (ADR-0028).
#
# Triggers POST /api/inventory/sync-sales on the inventory-api so theoretical
# on-hand depletes as items sell. The endpoint needs the internal bearer
# (INVENTORY_INTERNAL_TOKEN) to authenticate, and inventory-api's own
# Infisical-injected ANALYTICS_ADMIN_TOKEN to read the sold-items feed — so this
# sources the bearer from Infisical (env=prod, path=/) and the actual call runs
# from INSIDE the inventory-api container (localhost:4100), reusing the app's
# injected secrets. The DB is host-internal, so there is no public route to hit.
#
# Mirrors backup-postgres-cron.sh: a bare crontab line can't do Infisical
# injection, so this sources ONLY the machine-identity vars from a stack env
# file, points with-infisical at the inventory secret path, and runs the call.
#
# Install (host crontab, every 15 min):
#   */15 * * * * $HOME/restaurant-ops-platform/scripts/sync-sales-cron.sh >> $HOME/sync-sales.log 2>&1
#
# Manual: ./scripts/sync-sales-cron.sh
set -euo pipefail
cd "$(dirname "$0")/.."  # repo root

# Machine identity (secret-zero) — the same Universal Auth identity every stack
# uses; borrow it from kds.env. grep-then-source so we pull ONLY these two keys.
ID_ENV="${SYNC_INFISICAL_ID_ENV:-compose/kds.env}"
if [ ! -f "$ID_ENV" ]; then
  echo "[sync-sales-cron] ABORT: machine-identity env file not found: $ID_ENV" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090  # dynamic source of a grep-filtered subset; nothing static to follow
. <(grep -E '^INFISICAL_MACHINE_CLIENT_(ID|SECRET)=' "$ID_ENV")
set +a

# inventory-api secrets (incl. INVENTORY_INTERNAL_TOKEN) live at env=prod path=/
# — the default the inventory stack's with-infisical entrypoint uses.
export INFISICAL_SECRET_PATH=/
exec bash ./scripts/with-infisical.sh bash ./scripts/sync-sales.sh
