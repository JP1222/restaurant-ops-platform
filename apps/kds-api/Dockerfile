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
COPY apps/kds-api/package.json apps/kds-api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db-kds/package.json packages/db-kds/package.json
COPY packages/db-auth/package.json packages/db-auth/package.json
COPY packages/auth/package.json packages/auth/package.json

# `--filter @rop/kds-api...` restricts install to kds-api's transitive
# workspace dep tree {auth, contracts, db-kds}. Without this, pnpm installed
# every workspace's deps (including all of kds-web's Next.js + React tree),
# bloating the install layer ~600MB per build. Combined with not copying
# apps/kds-web/package.json above, kds-api's build is now cache-isolated from
# any kds-web changes.
RUN --mount=type=cache,id=rop-pnpm,target=/pnpm/store,sharing=locked \
  --mount=type=cache,id=rop-pnpm-metadata,target=/root/.cache/pnpm,sharing=locked \
  pnpm install --frozen-lockfile --offline --prod=false \
    --filter @rop/kds-api... \
    --store-dir /pnpm/store

FROM deps AS build

COPY packages/contracts packages/contracts
COPY packages/auth packages/auth
COPY packages/db-kds packages/db-kds
COPY packages/db-auth packages/db-auth
COPY apps/kds-api apps/kds-api

RUN --mount=type=cache,id=rop-pnpm,target=/pnpm/store,sharing=locked \
  --mount=type=cache,id=rop-pnpm-metadata,target=/root/.cache/pnpm,sharing=locked \
  pnpm --filter @rop/db-kds generate \
  && pnpm --filter @rop/db-auth generate \
  && pnpm --filter @rop/contracts build \
  && pnpm --filter @rop/db-kds build \
  && pnpm --filter @rop/db-auth build \
  && pnpm --filter @rop/auth build \
  && pnpm --filter @rop/kds-api build \
  && pnpm --prefer-offline --filter @rop/kds-api deploy --prod --legacy /prod/api
# NOTE: No final `prisma generate` inside /prod/api (removed). db-kds and db-auth
# each generate to a package-local path (`output = "./generated/client"`, i.e.
# prisma/generated/client) in the two `generate` steps above, and each package's
# `files: ["prisma"]` makes `pnpm deploy` bundle that directory into
# /prod/api/node_modules/@rop/<pkg>/prisma/generated/client — which is what
# db-kds / db-auth `src/index.ts` import at runtime. Re-running `prisma generate`
# inside /prod/api fails with "Could not resolve @prisma/client": in the deploy's
# pnpm layout @prisma/client is a transitive dep under .pnpm/, not at the top-level
# path Prisma's generator probes upward from the schema. The old step only ever
# succeeded because the warm deploy cache replayed a layer built before db-kds
# moved to package-local client output (ADR-0015) — the cache masked the break
# until a cold rebuild ran it (the ADR-0036 docker-build soak leg). This now
# matches apps/inventory-api/Dockerfile and apps/crm-api/Dockerfile, which
# deliberately omit the same step for the same reason.

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

COPY --from=build --chown=nodejs:nodejs /prod/api ./

# prisma.config.ts must sit at CWD so the two `migrate` / `migrate-auth`
# sidecars in compose/kds.yml (which run from /app) can resolve
# DATABASE_URL into the datasource. Prisma 7 forbids `url` in schema files
# and only searches CWD-upward for prisma.config.ts — it never descends into
# node_modules/. db-kds and db-auth ship identical configs (both just read
# process.env.DATABASE_URL), so copying one is sufficient for both migrate
# sidecars and any future ad-hoc `prisma` invocations from /app. Mirrors the
# inventory-api pattern landed in #115.
COPY --from=build --chown=nodejs:nodejs /app/packages/db-kds/prisma.config.ts ./prisma.config.ts

USER nodejs

EXPOSE 4000

ENTRYPOINT ["with-infisical"]
CMD ["node", "dist/index.js"]
