# syntax=docker/dockerfile:1.7

# order-web is a Next.js 16 standalone app. Its BFF (app/api/order/*) imports
# @rop/contracts, so the build copies + builds that workspace package
# before `next build` (pattern follows kds-web). alpine + pnpm fetch +
# --offline install + standalone output.

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

COPY package.json .npmrc pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json eslint.config.mjs eslint.boundaries.mjs ./
COPY scripts/require-pnpm-install.mjs scripts/require-pnpm-install.mjs
COPY apps/order-web/package.json apps/order-web/package.json
COPY packages/contracts/package.json packages/contracts/package.json

RUN --mount=type=cache,id=rop-pnpm,target=/pnpm/store,sharing=locked \
  --mount=type=cache,id=rop-pnpm-metadata,target=/root/.cache/pnpm,sharing=locked \
  pnpm install --frozen-lockfile --offline --prod=false \
    --filter @rop/order-web... \
    --store-dir /pnpm/store

FROM deps AS build

COPY packages/contracts packages/contracts
# next.config.ts statically imports a shared dev-source resolution module from
# config/ (PR #660). It's a prod no-op, but the ESM file must exist in the build
# context or `next build` fails to load the config. Keep this COPY before app source.
COPY config config
COPY apps/order-web apps/order-web

ENV NEXT_TELEMETRY_DISABLED=1

# Clover Ecommerce browser config — NEXT_PUBLIC_* must be present at BUILD time
# (Next.js inlines them into the client bundle; a runtime env var is too late).
# All three are NON-secret (publishable key + merchant id + env), passed as
# build-args from GitHub repo variables in build-images.yml. Empty default →
# Checkout degrades to the graceful "payment not configured" state
# (lib/clover-sdk.ts readCloverConfig() → null), so the image still builds
# before the variables are set.
ARG NEXT_PUBLIC_CLOVER_ECOMM_PUBLIC_KEY=""
ARG NEXT_PUBLIC_CLOVER_MERCHANT_ID=""
ARG NEXT_PUBLIC_CLOVER_ENV=""
ENV NEXT_PUBLIC_CLOVER_ECOMM_PUBLIC_KEY=$NEXT_PUBLIC_CLOVER_ECOMM_PUBLIC_KEY \
    NEXT_PUBLIC_CLOVER_MERCHANT_ID=$NEXT_PUBLIC_CLOVER_MERCHANT_ID \
    NEXT_PUBLIC_CLOVER_ENV=$NEXT_PUBLIC_CLOVER_ENV

# Sentry build-time wiring (ADR-0014 follow-up #2). See apps/kds-web/Dockerfile
# for the full rationale. NEXT_PUBLIC_SENTRY_DSN must be present at BUILD time
# (Next.js inlines it into the client bundle; a runtime env var is too late).
# All empty by default → no-op until CI provides them.
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
  --mount=type=cache,id=rop-next,target=/app/apps/order-web/.next/cache,sharing=locked \
  --mount=type=secret,id=sentry_auth_token \
  export SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)"; \
  pnpm --filter @rop/contracts build \
  && pnpm --filter @rop/order-web build

FROM node:24-alpine AS runtime

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3004

WORKDIR /app

RUN apk add --no-cache curl

RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

COPY --from=build --chown=nextjs:nodejs /app/apps/order-web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/order-web/.next/static ./apps/order-web/.next/static

USER nextjs

EXPOSE 3004

CMD ["node", "apps/order-web/server.js"]
