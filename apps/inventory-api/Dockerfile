# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS base

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

FROM base AS deps

COPY pnpm-lock.yaml pnpm-workspace.yaml ./

RUN --mount=type=cache,id=rop-pnpm,target=/pnpm/store,sharing=locked \
  --mount=type=cache,id=rop-pnpm-metadata,target=/root/.cache/pnpm,sharing=locked \
  pnpm fetch --frozen-lockfile --store-dir /pnpm/store

COPY package.json .npmrc pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY scripts/require-pnpm-install.mjs scripts/require-pnpm-install.mjs
COPY apps/inventory-api/package.json apps/inventory-api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db-inventory/package.json packages/db-inventory/package.json
COPY packages/db-auth/package.json packages/db-auth/package.json
COPY packages/auth/package.json packages/auth/package.json

# Restrict install to inventory-api's transitive workspace tree {contracts,
# db-inventory, db-auth (via auth), auth}.
RUN --mount=type=cache,id=rop-pnpm,target=/pnpm/store,sharing=locked \
  --mount=type=cache,id=rop-pnpm-metadata,target=/root/.cache/pnpm,sharing=locked \
  pnpm install --frozen-lockfile --offline --prod=false \
    --filter @rop/inventory-api... \
    --store-dir /pnpm/store

FROM deps AS build

COPY packages/contracts packages/contracts
COPY packages/db-inventory packages/db-inventory
COPY packages/db-auth packages/db-auth
COPY packages/auth packages/auth
COPY apps/inventory-api apps/inventory-api

RUN --mount=type=cache,id=rop-pnpm,target=/pnpm/store,sharing=locked \
  --mount=type=cache,id=rop-pnpm-metadata,target=/root/.cache/pnpm,sharing=locked \
  pnpm --filter @rop/db-inventory generate \
  && pnpm --filter @rop/db-auth generate \
  && pnpm --filter @rop/contracts build \
  && pnpm --filter @rop/db-inventory build \
  && pnpm --filter @rop/db-auth build \
  && pnpm --filter @rop/auth build \
  && pnpm --filter @rop/inventory-api build \
  && pnpm --prefer-offline --filter @rop/inventory-api deploy --prod --legacy /prod/api
# NOTE: Unlike kds-api's Dockerfile, no final `prisma generate` step is needed
# here. db-inventory's schema has `output = "../generated/client"` (custom
# output path), so the first `pnpm --filter @rop/db-inventory generate`
# above writes to packages/db-inventory/generated/client/. db-inventory's
# package.json declares `files: ["dist", "prisma", "generated"]`, so pnpm
# deploy bundles that directory into /prod/api/node_modules/@rop/
# db-inventory/generated/. Re-running prisma generate inside /prod/api would
# error with "Could not resolve @prisma/client" because the deploy node_modules
# layout doesn't expose @prisma/client at the path Prisma's generator probes.

FROM node:24-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

RUN apk add --no-cache curl ca-certificates tar

# Infisical CLI (static linux binary) + resilient secret-injection entrypoint
# (ADR-0020). No-op unless an Infisical credential is present in env — see
# scripts/with-infisical.sh. Pinned; bump INFISICAL_CLI_VERSION to upgrade.
ARG INFISICAL_CLI_VERSION=0.43.89
RUN ARCH="$(uname -m)"; case "$ARCH" in x86_64) A=amd64 ;; aarch64|arm64) A=arm64 ;; *) A="$ARCH" ;; esac; \
    curl -sSL "https://github.com/Infisical/cli/releases/download/v${INFISICAL_CLI_VERSION}/cli_${INFISICAL_CLI_VERSION}_linux_${A}.tar.gz" \
    | tar -xz -C /usr/local/bin infisical \
 && chmod +x /usr/local/bin/infisical
COPY --chmod=755 scripts/with-infisical.sh /usr/local/bin/with-infisical

RUN addgroup -S nodejs && adduser -S nodejs -G nodejs

COPY --from=build --chown=nodejs:nodejs /prod/api ./

# prisma.config.ts must sit at CWD so `prisma migrate deploy` (run from /app by
# the compose migrate service) can resolve INVENTORY_DATABASE_URL into the
# datasource. Prisma 7 forbids `url` in schema files; the config file is the
# only mechanism for migrations under driverAdapters mode. pnpm deploy only
# lands the file at node_modules/@rop/db-inventory/, which Prisma's
# CWD-upward search never reaches.
COPY --from=build --chown=nodejs:nodejs /app/packages/db-inventory/prisma.config.ts ./prisma.config.ts

USER nodejs

EXPOSE 4100

# Image-level liveness/readiness probe so the container is self-describing even
# when the orchestrator ships no healthcheck (a copied Dockerfile, a drifted
# compose, or a plain `docker run`). Probes the readiness endpoint, which
# exercises Postgres via Prisma (`SELECT 1` only — no allocation per tick), so a
# container whose DB is unreachable is reported `unhealthy` instead of falsely
# `healthy`. curl is baked into this runtime stage (see `apk add` above) per the
# repo's healthcheck convention (slim images otherwise lack it, which silently
# breaks the probe). When compose/inventory.yml runs this image its own
# `healthcheck:` block overrides this directive (a Compose-level healthcheck
# always wins), so the two coexist without conflict.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4100/api/ready || exit 1

ENTRYPOINT ["with-infisical"]
CMD ["node", "dist/index.js"]
