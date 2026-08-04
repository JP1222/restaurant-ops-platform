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
COPY apps/analytics-api/package.json apps/analytics-api/package.json
COPY packages/contracts/package.json packages/contracts/package.json

RUN --mount=type=cache,id=rop-pnpm,target=/pnpm/store,sharing=locked \
  --mount=type=cache,id=rop-pnpm-metadata,target=/root/.cache/pnpm,sharing=locked \
  pnpm install --frozen-lockfile --offline --prod=false \
    --filter @rop/analytics-api... \
    --store-dir /pnpm/store

FROM deps AS build

COPY packages/contracts packages/contracts
COPY apps/analytics-api apps/analytics-api

RUN --mount=type=cache,id=rop-pnpm,target=/pnpm/store,sharing=locked \
  --mount=type=cache,id=rop-pnpm-metadata,target=/root/.cache/pnpm,sharing=locked \
  pnpm --filter @rop/contracts build \
  && pnpm --filter @rop/analytics-api build \
  && pnpm --prefer-offline --filter @rop/analytics-api deploy --prod --legacy /prod/analytics

FROM node:24-alpine AS runtime

ARG SENTRY_RELEASE=""
ENV SENTRY_RELEASE=$SENTRY_RELEASE

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

# Bring in the prod-only node_modules from `pnpm deploy --prod` AND explicitly
# copy build artifacts (dist/) + SQL migrations (sql/). `pnpm deploy --prod`
# alone drops `dist/` (gitignored) and `sql/` from the deploy tree, so the
# runtime CMD `node dist/src/service.js` fails with MODULE_NOT_FOUND. We
# overlay them from the build stage's source tree.
COPY --from=build --chown=nodejs:nodejs /prod/analytics ./
COPY --from=build --chown=nodejs:nodejs /app/apps/analytics-api/dist ./dist
COPY --from=build --chown=nodejs:nodejs /app/apps/analytics-api/sql ./sql

# Runtime export cache: compose mounts the `clover-exports` named volume here
# (RAW_EXPORT_DIR in compose/analytics.yml). Create + own the mountpoint as nodejs
# so a fresh, empty named volume inherits nodejs ownership on first mount. Without
# this, Docker auto-creates the mountpoint root:root and the non-root runtime user
# cannot write downloaded exports — EACCES, which silently blocks every historical
# backfill window. NB: volumes created before this line keep their old ownership
# and still need a one-time `chown -R nodejs:nodejs` on the host.
RUN mkdir -p /var/lib/rop-intelligence/clover-exports \
 && chown -R nodejs:nodejs /var/lib/rop-intelligence

USER nodejs

EXPOSE 3100

ENTRYPOINT ["with-infisical"]
CMD ["node", "dist/src/service.js"]
