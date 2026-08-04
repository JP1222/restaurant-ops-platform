# restaurant-ops-platform — local dev task runner.
# Verbs are the stable interface; targets delegate to scripts/pnpm underneath.
# Secrets are injected at the command boundary by scripts/with-secrets.sh
# (committed dev defaults by default; Infisical when SECRETS_BACKEND=infisical).
# `make test` runs OUTSIDE that seam — tests own their throwaway services.

SHELL        := /usr/bin/env bash
.SHELLFLAGS  := -euo pipefail -c
.DEFAULT_GOAL := help

WITH_SECRETS := ./scripts/with-secrets.sh
COMPOSE      := docker compose -f docker-compose.dev.yml
DEV_FILTERS  := --filter=@rop/kds-api --filter=@rop/kds-web --filter=@rop/inventory-api --filter=@rop/analytics-api --filter=@rop/backoffice-web --filter=@rop/notifications-api

.PHONY: help dev-up dev down dev-down reset db-migrate db-migrate-deploy seed admin test test-integration e2e doctor

help: ## Show this menu
	@grep -hE '^[a-zA-Z0-9_ -]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

dev-up: ## Fresh clone -> bootstrapped stack (idempotent: install, DBs, migrate, seed)
	@./scripts/dev-up.sh

dev: ## Launch the 6-app stack (run after dev-up)
	@$(WITH_SECRETS) -- pnpm exec turbo run dev --env-mode=loose --continue $(DEV_FILTERS)

down dev-down: ## Stop backing services (keep volumes/data)
	@$(COMPOSE) down

reset: ## DESTRUCTIVE: drop volumes, then re-bootstrap from scratch
	@$(COMPOSE) down -v
	@./scripts/dev-up.sh

db-migrate: ## Apply pending migrations to all 3 DBs (kds+auth+inventory, non-interactive)
	@$(WITH_SECRETS) -- pnpm db:migrate:deploy

db-migrate-deploy: ## Non-interactive migrate (CI / teammate machine)
	@$(WITH_SECRETS) -- pnpm db:migrate:deploy

seed: ## Seed inventory demo data (idempotent)
	@$(WITH_SECRETS) -- pnpm db:seed

admin: ## (Re)set the fixed local admin login (admin / admin) — no stack needed
	@$(WITH_SECRETS) -- ./scripts/seed-admin.sh

test: ## Unit tests — mocked, fast, no Docker/compose/secrets (turbo run test)
	@pnpm exec turbo run test

test-integration: ## Integration tests — real ephemeral Postgres/Redis via Testcontainers (needs Docker)
	@pnpm test:integration

e2e: ## Playwright suites (kds-web + backoffice-web + crew-web)
	@$(WITH_SECRETS) -- pnpm test:e2e

doctor: ## Diagnose the local environment (Docker, ports, built libs, secrets)
	@./scripts/doctor.sh
