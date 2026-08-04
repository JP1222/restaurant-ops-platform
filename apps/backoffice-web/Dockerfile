# syntax=docker/dockerfile:1.7
# backoffice-web stays on bookworm-slim (glibc) — @node-rs/argon2 prebuilt
# binaries for arm64 musl don't resolve cleanly under QEMU cross-build.
# Deps stage also uses the legacy single-pass `pnpm install` (no fetch +
# --offline split) — the fetch+offline pattern triggered "Cannot find
# module '@node-rs/argon2'" at `next build` for reasons that may relate
# to pnpm 10.33 + monorepo transitive workspace deps + --offline together.
# The other three apps (kds-api, kds-web, analytics-api) are alpine + fetch
# pattern, which CI confirms works (force_all run 26048104420).

FROM node:24-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

FROM base AS deps

COPY package.json .npmrc pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY scripts/require-pnpm-install.mjs scripts/require-pnpm-install.mjs
COPY apps/backoffice-web/package.json apps/backoffice-web/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db-auth/package.json packages/db-auth/package.json
COPY packages/db-kds/package.json packages/db-kds/package.json

RUN --mount=type=cache,id=rop-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod=false \
      --filter @rop/backoffice-web... \
      --store-dir /pnpm/store

FROM deps AS build

ENV CI=true
ENV NEXT_TELEMETRY_DISABLED=1

COPY packages/contracts packages/contracts
COPY packages/auth packages/auth
COPY packages/db-kds packages/db-kds
COPY packages/db-auth packages/db-auth
# next.config.ts statically imports a shared dev-source resolution module from
# config/ (PR #660). It's a prod no-op, but the ESM file must exist in the build
# context or `next build` fails to load the config. Keep this COPY before app source.
COPY config config
COPY apps/backoffice-web apps/backoffice-web

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
  --mount=type=cache,id=rop-next,target=/app/apps/backoffice-web/.next/cache,sharing=locked \
  --mount=type=secret,id=sentry_auth_token \
  export SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)"; \
  pnpm --filter @rop/db-kds generate \
  && pnpm --filter @rop/db-auth generate \
  && pnpm --filter @rop/contracts build \
  && pnpm --filter @rop/db-kds build \
  && pnpm --filter @rop/db-auth build \
  && pnpm --filter @rop/auth build \
  && pnpm --filter @rop/backoffice-web build \
  && pnpm --prefer-offline --filter @rop/backoffice-web deploy --prod --legacy /prod/backoffice \
  && for src in /app/node_modules/.pnpm/@prisma+client@*/node_modules; do \
       name=$(basename "$(dirname "$src")"); \
       dst="/prod/backoffice/node_modules/.pnpm/$name/node_modules"; \
       if [ -d "$src/.prisma" ] && [ -d "$dst" ]; then \
         cp -a "$src/.prisma" "$dst/"; \
       fi; \
     done

FROM node:24-bookworm-slim AS runtime

ARG SENTRY_RELEASE=""
ENV SENTRY_RELEASE=$SENTRY_RELEASE

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3001

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates curl tar \
 && rm -rf /var/lib/apt/lists/*

# Infisical CLI (static linux binary) + resilient secret-injection entrypoint
# (ADR-0020). Aligned with the other 7 backends — the same static GitHub-release
# binary the alpine images use, which runs on bookworm (glibc) too since the CLI
# is a statically-linked Go binary. Was previously the heavier apt path
# (setup.deb.sh | bash + apt install infisical), which added an external apt-repo
# dependency + a curl|bash for no benefit. No-op unless an Infisical credential
# is present in env — see scripts/with-infisical.sh. Pinned; bump
# INFISICAL_CLI_VERSION to upgrade (kept identical across all 8 images).
ARG INFISICAL_CLI_VERSION=0.43.89
RUN ARCH="$(uname -m)"; case "$ARCH" in x86_64) A=amd64 ;; aarch64|arm64) A=arm64 ;; *) A="$ARCH" ;; esac; \
    curl -sSL "https://github.com/Infisical/cli/releases/download/v${INFISICAL_CLI_VERSION}/cli_${INFISICAL_CLI_VERSION}_linux_${A}.tar.gz" \
    | tar -xz -C /usr/local/bin infisical \
 && chmod +x /usr/local/bin/infisical
COPY --chmod=755 scripts/with-infisical.sh /usr/local/bin/with-infisical

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# Standalone output ships its own minimal node_modules with everything Next.js
# nft traced. Native externals (@node-rs/argon2, @prisma/client, ioredis) are
# explicitly listed in next.config.ts → outputFileTracingIncludes so they get
# bundled into .next/standalone/node_modules/. No second node_modules copy
# needed — that prior approach shipped the entire pnpm-deploy tree (~1.2GB)
# which collapsed standalone's whole point. See PR for image size impact.
COPY --from=build --chown=nextjs:nodejs /app/apps/backoffice-web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/backoffice-web/.next/static ./apps/backoffice-web/.next/static
COPY --from=build --chown=nextjs:nodejs /app/apps/backoffice-web/public ./apps/backoffice-web/public

USER nextjs
EXPOSE 3001

ENTRYPOINT ["with-infisical"]
CMD ["node", "apps/backoffice-web/server.js"]
