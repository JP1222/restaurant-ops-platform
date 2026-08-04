# syntax=docker/dockerfile:1.7

# crew-web is a Next.js 16 standalone app — only @rop/contracts as a
# workspace dep (used by sentry-init.ts for shared error-tag types). Pattern
# follows kds-web (alpine + pnpm fetch + --offline install + standalone output)
# but builds contracts first so the workspace symlink resolves.

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
COPY apps/crew-web/package.json apps/crew-web/package.json
COPY packages/contracts/package.json packages/contracts/package.json

# `--filter @rop/crew-web...` (with `...`) pulls crew-web + its
# transitive workspace deps ({contracts}) — without it pnpm only installs
# crew-web itself and the contracts symlink dangles.
RUN --mount=type=cache,id=rop-pnpm,target=/pnpm/store,sharing=locked \
  --mount=type=cache,id=rop-pnpm-metadata,target=/root/.cache/pnpm,sharing=locked \
  pnpm install --frozen-lockfile --offline --prod=false \
    --filter @rop/crew-web... \
    --store-dir /pnpm/store

FROM deps AS build

COPY packages/contracts packages/contracts
# next.config.ts statically imports a shared dev-source resolution module from
# config/ (PR #660). It's a prod no-op, but the ESM file must exist in the build
# context or `next build` fails to load the config. Keep this COPY before app source.
COPY config config
COPY apps/crew-web apps/crew-web

ENV NEXT_TELEMETRY_DISABLED=1

# Sentry build-time wiring (ADR-0014 follow-up #2). See apps/kds-web/Dockerfile
# for the full rationale. All empty by default → no-op until CI provides them.
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
  --mount=type=cache,id=rop-next,target=/app/apps/crew-web/.next/cache,sharing=locked \
  --mount=type=secret,id=sentry_auth_token \
  export SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)"; \
  pnpm --filter @rop/contracts build \
  && pnpm --filter @rop/crew-web build

FROM node:24-alpine AS runtime

ARG SENTRY_RELEASE=""
ENV SENTRY_RELEASE=$SENTRY_RELEASE

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3003

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

COPY --from=build --chown=nextjs:nodejs /app/apps/crew-web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/crew-web/.next/static ./apps/crew-web/.next/static

USER nextjs

EXPOSE 3003

ENTRYPOINT ["with-infisical"]
CMD ["node", "apps/crew-web/server.js"]
