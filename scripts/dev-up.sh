#!/usr/bin/env bash
# scripts/dev-up.sh — fresh clone → bootstrapped 6-app stack, idempotent.
#
# Invoked under the secrets seam:  scripts/with-secrets.sh -- ./scripts/dev-up.sh
# (which is what `make dev-up` does). Every mutation is guarded so a second run
# converges instead of erroring. This provisions and migrates; it does NOT keep
# the apps running — start them with `make dev`.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Re-exec under the secrets seam so DATABASE_URL etc. are present — makes
# `pnpm bootstrap:dev` and a bare `./scripts/dev-up.sh` work, not just
# `make dev-up`. The sentinel prevents a re-exec loop.
if [ -z "${YR_SECRETS_WRAPPED:-}" ]; then
  export YR_SECRETS_WRAPPED=1
  exec "$ROOT_DIR/scripts/with-secrets.sh" -- "$0" "$@"
fi

COMPOSE=(docker compose -f docker-compose.dev.yml)

log() { printf '\033[36m▶ %s\033[0m\n' "$*"; }
ok()  { printf '\033[32m✓ %s\033[0m\n' "$*"; }

# 1. Toolchain + deps ---------------------------------------------------------
log "Ensuring pnpm and installing dependencies"
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable && corepack prepare pnpm@10.33.0 --activate
fi
pnpm install --frozen-lockfile
ok "Dependencies installed"

# 2. Backing services, gated on health ---------------------------------------
log "Starting Postgres (kds:5432, inventory:5433, analytics:5434, notifications:5435, crm:5436) + Redis — waiting for healthy"
"${COMPOSE[@]}" up -d --wait
ok "Backing services healthy"

# 3. Analytics DB — idempotent create (belt-and-suspenders vs the compose svc) -
log "Ensuring analytics database exists"
./scripts/create-analytics-db.sh
ok "Analytics database present"

# 4. Prisma clients (all three) ----------------------------------------------
log "Generating Prisma clients (kds, auth, inventory)"
pnpm db:generate
ok "Prisma clients generated"

# 5. Build workspace libraries BEFORE the tsx apps can import their dist/ ------
log "Building workspace libraries (contracts, auth, db-*)"
pnpm exec turbo run build --filter='./packages/*'
ok "Libraries built"

# 6. Migrations — kds + auth + inventory in one non-interactive shot (db:migrate:deploy),
#    then crm (its own database, Iron Law 1) ------------------------------------
log "Applying migrations: kds + auth + inventory (analytics self-migrates on boot)"
pnpm db:migrate:deploy
# db-crm owns a SEPARATE database (Iron Law 1 — CRM_DATABASE_URL), created by the
# postgres-crm compose service above. It is not part of the bundled db:migrate:deploy
# script, so apply it explicitly here (mirrors the CI migration smoke job in
# .github/workflows/ci.yml). crm-api itself is started on demand, not by `make dev`.
log "Applying migrations: crm"
pnpm --filter @rop/db-crm exec prisma migrate deploy --schema ./prisma/schema.prisma
# db-notifications also owns a SEPARATE database (Iron Law 1 — NOTIFICATIONS_DATABASE_URL),
# created by the postgres-notifications compose service above. Not part of the bundled
# db:migrate:deploy script either, so apply it explicitly here. Unlike crm-api,
# notifications-api IS in the default `make dev` stack.
log "Applying migrations: notifications"
pnpm --filter @rop/db-notifications exec prisma migrate deploy --schema ./prisma/schema.prisma
ok "Relational migrations applied"

# 7. Seed demo data (idempotent) ---------------------------------------------
log "Seeding inventory demo data"
pnpm db:seed || echo "  (inventory seed skipped — see output above)"

# 8. First admin — fixed local login, written straight to db-auth ------------
log "Setting the fixed local admin login (admin / admin)"
./scripts/seed-admin.sh || true

# 9. Ready -------------------------------------------------------------------
cat <<'URLS'

  ✅ Stack bootstrapped. Start it with:  make dev

     Board (kds-web) ........ http://localhost:3000
     Backoffice ............. http://localhost:3001
     kds-api ................ http://localhost:4000
     inventory-api .......... http://localhost:4100
     analytics-api (health) . http://localhost:3100/healthz
     notifications-api (h) .. http://localhost:4400/api/health

  crm-api is not in `make dev` (its DB is provisioned above) — start on demand:
     pnpm --filter @rop/crm-api dev      # http://localhost:4200

  Log in with:  admin / admin   (re-set anytime with `make admin`)
  Run tests (no stack, no secrets):  make test
URLS
