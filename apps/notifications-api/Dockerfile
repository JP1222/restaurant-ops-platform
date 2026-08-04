# syntax=docker/dockerfile:1.7
#
# Single entrypoint: the HTTP API (`node dist/index.js`). Unlike crm-api/kds-api
# there is no worker — notifications-api has no queue consumer yet (producers +
# realtime are a later phase). Otherwise structurally a mirror of
# apps/crm-api/Dockerfile (same Fastify + single-db-package shape, custom Prisma
# output path): no auth dependency, so db-auth/auth are dropped; the port is 4400.

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
COPY apps/notifications-api/package.json apps/notifications-api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db-notifications/package.json packages/db-notifications/package.json

# Restrict install to notifications-api's transitive workspace tree
# {contracts, db-notifications}.
RUN --mount=type=cache,id=rop-pnpm,target=/pnpm/store,sharing=locked \
  --mount=type=cache,id=rop-pnpm-metadata,target=/root/.cache/pnpm,sharing=locked \
  pnpm install --frozen-lockfile --offline --prod=false \
    --filter @rop/notifications-api... \
    --store-dir /pnpm/store

FROM deps AS build

COPY packages/contracts packages/contracts
COPY packages/db-notifications packages/db-notifications
COPY apps/notifications-api apps/notifications-api

RUN --mount=type=cache,id=rop-pnpm,target=/pnpm/store,sharing=locked \
  --mount=type=cache,id=rop-pnpm-metadata,target=/root/.cache/pnpm,sharing=locked \
  pnpm --filter @rop/db-notifications generate \
  && pnpm --filter @rop/contracts build \
  && pnpm --filter @rop/db-notifications build \
  && pnpm --filter @rop/notifications-api build \
  && pnpm --prefer-offline --filter @rop/notifications-api deploy --prod --legacy /prod/api
# Like crm-api/inventory-api (and unlike kds-api): db-notifications' schema uses a
# custom output path (`output = "../generated/client"`), so the `db-notifications
# generate` above writes packages/db-notifications/generated/client/ and `pnpm
# deploy` bundles it (db-notifications' package.json `files` includes "generated").
# No final `prisma generate` inside /prod/api is needed — it would fail to resolve
# @prisma/client in the deploy node_modules layout.

FROM node:24-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

RUN apk add --no-cache curl ca-certificates tar

# Infisical CLI (static linux binary) + the resilient secret-injection entrypoint
# (ADR-0020), same as the other backends. No-op unless an Infisical credential is
# present in env — see scripts/with-infisical.sh.
ARG INFISICAL_CLI_VERSION=0.43.89
RUN ARCH="$(uname -m)"; case "$ARCH" in x86_64) A=amd64 ;; aarch64|arm64) A=arm64 ;; *) A="$ARCH" ;; esac; \
    curl -sSL "https://github.com/Infisical/cli/releases/download/v${INFISICAL_CLI_VERSION}/cli_${INFISICAL_CLI_VERSION}_linux_${A}.tar.gz" \
    | tar -xz -C /usr/local/bin infisical \
 && chmod +x /usr/local/bin/infisical
COPY --chmod=755 scripts/with-infisical.sh /usr/local/bin/with-infisical

RUN addgroup -S nodejs && adduser -S nodejs -G nodejs

COPY --from=build --chown=nodejs:nodejs /prod/api ./

# prisma.config.ts must sit at CWD so `prisma migrate deploy` (run from /app by
# the compose migrate service) can resolve NOTIFICATIONS_DATABASE_URL into the
# datasource. Prisma 7 forbids `url` in schema files; the config file is the only
# mechanism for migrations under driverAdapters mode. pnpm deploy only lands the
# file at node_modules/@rop/db-notifications/, which Prisma's CWD-upward
# search never reaches.
COPY --from=build --chown=nodejs:nodejs /app/packages/db-notifications/prisma.config.ts ./prisma.config.ts

USER nodejs

EXPOSE 4400

ENTRYPOINT ["with-infisical"]
CMD ["node", "dist/index.js"]
