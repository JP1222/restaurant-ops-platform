#!/usr/bin/env bash
# sync-sales.sh — the actual depletion poll call, run under with-infisical by
# sync-sales-cron.sh (so INVENTORY_INTERNAL_TOKEN is injected into the env).
#
# Runs from INSIDE the inventory-api container: the prod inventory DB + the
# Infisical-injected analytics token live in the app process, and the app is
# only reachable on its own localhost:4100 (no public route). The bearer is
# passed in as BEARER; the app re-validates it against its own injected token.
#
# runDepletionPoll is idempotent and only advances the cursor on success, so an
# occasional slow/failed run is harmless — the next run retries from the same
# watermark.
set -euo pipefail

: "${INVENTORY_INTERNAL_TOKEN:?INVENTORY_INTERNAL_TOKEN not injected — run via sync-sales-cron.sh}"
CONTAINER="${SYNC_SALES_CONTAINER:-rop-inventory-inventory-api-1}"

exec docker exec -e BEARER="$INVENTORY_INTERNAL_TOKEN" "$CONTAINER" node -e '
const t = Date.now();
fetch("http://localhost:4100/api/inventory/sync-sales", {
  method: "POST",
  headers: { authorization: "Bearer " + process.env.BEARER }
})
  .then((r) => r.text().then((b) => {
    console.log(new Date().toISOString(), "sync-sales", r.status, (Date.now() - t) + "ms", b);
    if (!r.ok) process.exit(1);
  }))
  .catch((e) => {
    console.error(new Date().toISOString(), "sync-sales ERR", e.message);
    process.exit(1);
  });
'
