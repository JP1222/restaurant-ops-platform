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

COPY package.json .npmrc pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.mjs ./
COPY scripts/require-pnpm-install.mjs scripts/require-pnpm-install.mjs
COPY apps/kds-web/package.json apps/kds-web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db-auth/package.json packages/db-auth/package.json
COPY packages/auth/package.json packages/auth/package.json

# `--filter @rop/kds-web...` restricts install to kds-web's transitive
# workspace dep tree {auth, contracts, db-auth via auth}. Without this, pnpm
# installed every workspace's deps (including all of kds-api's Fastify +
# Prisma server tree), bloating the install layer ~500MB per build. Combined
# with not copying apps/kds-api/package.json above, kds-web's build is now
# cache-isolated from any kds-api changes. db-auth is in the COPY chain below
# because @rop/auth has a workspace dep on it for the WebAdminAccount /
# WebAuthnCredential Prisma surface (see ADR-0014).
RUN --mount=type=cache,id=rop-pnpm,target=/pnpm/store,sharing=locked \
  --mount=type=cache,id=rop-pnpm-metadata,target=/root/.cache/pnpm,sharing=locked \
  pnpm install --frozen-lockfile --offline --prod=false \
    --filter @rop/kds-web... \
    --store-dir /pnpm/store

FROM deps AS build

COPY packages/contracts packages/contracts
COPY packages/auth packages/auth
COPY packages/db-auth packages/db-auth
# next.config.ts statically imports a shared dev-source resolution module from
# config/ (PR #660). It's a prod no-op, but the ESM file must exist in the build
# context or `next build` fails to load the config. Keep this COPY before app source.
COPY config config
COPY apps/kds-web apps/kds-web

ENV NEXT_TELEMETRY_DISABLED=1

# Sentry build-time wiring (ADR-0014 follow-up #2). NEXT_PUBLIC_* bake into the
# browser bundle so client-side errors are captured; SENTRY_* + the
# sentry_auth_token BuildKit secret let withSentryConfig upload source maps and
# name the release. All empty by default → withSentryConfig disables upload and
# the client init is a no-op — i.e. unchanged behavior until CI provides them.
ARG NEXT_PUBLIC_SENTRY_DSN=""
ARG NEXT_PUBLIC_SENTRY_RELEASE=""
ARG SENTRY_ORG=""
ARG SENTRY_RELEASE=""
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_PUBLIC_SENTRY_RELEASE=$NEXT_PUBLIC_SENTRY_RELEASE \
    SENTRY_ORG=$SENTRY_ORG \
    SENTRY_RELEASE=$SENTRY_RELEASE

RUN --mount=type=cache,id=rop-pnpm,target=/pnpm/store,sharing=locked \
  --mount=type=cache,id=rop-pnpm-metadata,target=/root/.cache/pnpm,sharing=locked \
  --mount=type=cache,id=rop-next,target=/app/apps/kds-web/.next/cache,sharing=locked \
  --mount=type=secret,id=sentry_auth_token \
  export SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)"; \
  pnpm --filter @rop/db-auth generate \
  && pnpm --filter @rop/contracts build \
  && pnpm --filter @rop/db-auth build \
  && pnpm --filter @rop/auth build \
  && pnpm --filter @rop/kds-web build

FROM node:24-alpine AS runtime

ARG SENTRY_RELEASE=""
ENV SENTRY_RELEASE=$SENTRY_RELEASE

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

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

RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

COPY --from=build --chown=nextjs:nodejs /app/apps/kds-web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/kds-web/.next/static ./apps/kds-web/.next/static

USER nextjs

EXPOSE 3000

ENTRYPOINT ["with-infisical"]
CMD ["node", "apps/kds-web/server.js"]
