# shellcheck shell=bash
# shellcheck disable=SC2034  # values are consumed by the sourcer via `set -a`
# scripts/dev-defaults.sh — NON-SECRET localhost defaults for local development.
#
# This is the committed, safe-to-read fallback the stack uses when Infisical is
# NOT in play (the role a `.env.defaults` would play; kept as a sourced shell
# fragment because tooling guards `.env*` files). It is sourced under `set -a`
# by scripts/with-secrets.sh, so every `KEY=value` below is exported into the
# child process. Override any value locally in a gitignored `.env.local`.
#
# Real / production secrets do NOT live here — they come from Infisical at
# runtime (ADR-0020). These dev dummies only have to be internally consistent
# (the cross-app bearer tokens must match on both ends, which they do here).

NODE_ENV=development

# Stable compose project name (so worktree vs main use the same containers/volumes).
COMPOSE_PROJECT_NAME=rop-dev

# ── Databases (docker-compose.dev.yml default ports) ─────────────────────────
# kds + auth share ONE physical Postgres (ADR-0015) → one DATABASE_URL.
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rop_kds
INVENTORY_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/rop_inventory
# analytics owns its OWN database (Iron Law 1/5) → distinct var + DB + port.
ANALYTICS_DATABASE_URL=postgresql://postgres:postgres@localhost:5434/rop_analytics
# notifications-api owns its OWN database too (Iron Law 1; ADR-0801) → distinct var
# + DB + port. Port 5435 (5434 is analytics, 5436 is crm). REQUIRED for
# notifications-api to boot; `make dev` launches it and scripts/dev-up.sh applies
# its Prisma migrations here.
NOTIFICATIONS_DATABASE_URL=postgresql://postgres:postgres@localhost:5435/rop_notifications
# crm-api owns its OWN database too (Iron Law 1 — loyalty/CRM, ADR-0021) → distinct
# var + DB + port. Port 5436 (5435 is reserved for notifications-api). REQUIRED for
# crm-api to boot; crm-api is NOT in `make dev` (start it on demand) and dev-up.sh
# applies its Prisma migrations to this DB.
CRM_DATABASE_URL=postgresql://postgres:postgres@localhost:5436/rop_crm
REDIS_URL=redis://localhost:6379

# ── Service base URLs ────────────────────────────────────────────────────────
APP_BASE_URL=http://localhost:3000
BACKOFFICE_BASE_URL=http://localhost:3001
INTERNAL_API_BASE_URL=http://localhost:4000        # kds-web      → kds-api
INTERNAL_KDS_API_URL=http://localhost:4000         # backoffice   → kds-api
INTERNAL_INVENTORY_API_URL=http://localhost:4100   # backoffice   → inventory-api
INTERNAL_ANALYTICS_API_URL=http://localhost:3100   # backoffice   → analytics-api
INTERNAL_BACKOFFICE_URL=http://localhost:3001      # crew-web     → backoffice (AI scan proxy)

# ── Cross-app bearer tokens (DEV DUMMIES; must match on both ends) ───────────
SESSION_SECRET=dev-session-secret-change-me
KDS_INTERNAL_ADMIN_TOKEN=dev-kds-internal-admin-token-0001
INVENTORY_INTERNAL_TOKEN=dev-inventory-internal-token-0001
# notifications-api is internal-only and dev-permissive: with no token its
# /api/notifications routes are OPEN locally (it fails closed only in production),
# so `make dev` boots it with just NOTIFICATIONS_DATABASE_URL (above). LEFT UNSET on
# purpose — the backoffice bell then stays on its bundled sample data (the BFF
# returns 503 "not connected"), a richer demo than the live-but-usually-empty local
# inbox (producers exist — ADR-0801 Phase 5a/b — but none fire unless you trigger an
# 86 / low-stock event locally). To exercise the LIVE backoffice→notifications path,
# set BOTH:
#   INTERNAL_NOTIFICATIONS_API_URL=http://localhost:4400
#   NOTIFICATIONS_INTERNAL_TOKEN=dev-notifications-internal-token-0001   # ≥16 chars
# crm-api (loyalty/CRM) is bearer-guarded but dev-permissive: with no token its
# /api/loyalty routes are OPEN locally (it fails closed only in production), so the
# backoffice /guests path works tokenless once crm-api is up. crm-api is NOT in
# `make dev` — start it on demand: `pnpm --filter @rop/crm-api dev` (:4200).
# LEFT UNSET on purpose — the backoffice /guests page then stays "not connected"
# (its BFF returns 503). To light up the LIVE backoffice→crm path, set:
#   INTERNAL_CRM_API_URL=http://localhost:4200
# and optionally exercise the bearer by setting CRM_INTERNAL_TOKEN on BOTH ends:
#   CRM_INTERNAL_TOKEN=dev-crm-internal-token-0001   # ≥16 chars
# Crew invoice-scan → backoffice AI-vision proxy (ADR-0538). LEFT UNSET in local dev
# on purpose: with no token, crew-web's scan route uses its built-in stub (samples
# the live catalog) so `make dev` demos without any AI key. To exercise the REAL
# vision path locally, set this (same value on crew-web + backoffice-web) AND a real
# Gemini key — `GEMINI_API_KEY` env or the `ai.vision_api_key` AppSetting at
# /settings/ai. NOT DeepSeek: its API has no vision (see lib/ai/vision-provider.ts).
# Simplest: `SECRETS_BACKEND=infisical` (dev env) injects both at once. Prod too.
# INTERNAL_AI_TOKEN=dev-internal-ai-token-0001
# analytics reads ADMIN_TOKEN; backoffice sends it as ANALYTICS_ADMIN_TOKEN — keep equal.
ADMIN_TOKEN=dev-analytics-admin-token-0001
ANALYTICS_ADMIN_TOKEN=dev-analytics-admin-token-0001

# ── Encryption keys (64-hex DEV keys; kds-api and backoffice use DIFFERENT vars) ─
AI_TOKEN_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
APP_SETTING_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

# ── Crew PIN auth (MUST match the db-inventory seed defaults or seeded PINs 401) ─
CREW_SESSION_SECRET=dev-crew-session-secret-change-me
CREW_PIN_PEPPER=dev-crew-pin-pepper-change-me

# ── WebAuthn / sessions (localhost dev) ──────────────────────────────────────
WEBAUTHN_RP_ID=localhost
WEBAUTHN_ORIGIN=http://localhost:3001
BACKOFFICE_SESSION_COOKIE_NAME=rop_backoffice_session

# ── First admin (set by `make admin` → scripts/seed-admin.sh; dev-only) ──────
# A FIXED local password so login is repeatable (no one-time password to copy).
# Change it here if you like — it only ever touches the local dev DB, and
# dev-admin.ts refuses to run with NODE_ENV=production.
DEV_ADMIN_USERNAME=admin
DEV_ADMIN_DISPLAY_NAME=Admin
DEV_ADMIN_PASSWORD=admin
