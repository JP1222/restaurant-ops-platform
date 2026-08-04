#!/usr/bin/env bash
# scripts/seed-admin.sh — (re)set a FIXED local admin password (dev-only) so
# backoffice / kds-web login is repeatable, with no one-time password to copy.
#
# Delegates to apps/kds-api/scripts/dev-admin.ts, run through kds-api's package
# context (where @rop/auth + @rop/db-auth + tsx all resolve). It
# writes db-auth directly — no running stack needed, idempotent (upsert). The
# NODE_ENV=production guard lives in dev-admin.ts. Invoked by `make admin`,
# which injects the dev env (DATABASE_URL, DEV_ADMIN_*) via
# scripts/with-secrets.sh.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
exec pnpm --filter @rop/kds-api exec tsx scripts/dev-admin.ts
