# API Agents

`apps/kds-api` owns the Fastify backend, provider integrations, auth/session routes, sync jobs, KDS ticket state, and WebSocket fanout. The server database remains the source of truth. Server auth implementation lives in `packages/auth`; `src/lib/web-auth.ts` is a compatibility shim.

Use these checks when relevant:

- `pnpm --filter @rop/kds-api build`
- `pnpm --filter @rop/kds-api test`
- `pnpm --filter @rop/kds-api test:integration`  # real ephemeral Postgres via Testcontainers (Docker); see [docs/TESTING.md](../../docs/TESTING.md)
- `pnpm --filter @rop/kds-api lint`

Do:

- Keep provider-specific payloads behind backend adapters, serializers, or route boundaries.
- Update `packages/contracts` before changing app-facing DTO shapes.
- Add or update tests when touching sync, auth, ticket actions, provider routes, or config parsing.
- Keep logs structured and avoid tokens, raw provider payloads, customer data, or secrets.
- KDS rows are POS-partitioned by `merchantId` (multi-location — [ADR-0018](../../docs/decisions/0018-multi-location-architecture.md) / [ADR-0019](../../docs/decisions/0019-decouple-store-identity-from-clover.md)), under the `tenant_id` trust boundary (multi-tenant — [ADR-0818](../../docs/decisions/0818-multi-tenant-platform-architecture.md)). Resolve a request's store via `resolveKdsMerchantId` and read `request.kdsMerchantId` set by the `/api/kds/*` preHandler — never hand-add a `?merchantId=` default. A device token carries its own bound store. **Session store resolution is gated by `MULTITENANT_MODE`** (Phase 2c): `off` (default) keeps the legacy interim IDOR-safe pin (a web session pins to the configured default merchant, `?merchantId=` ignored); `observe`/`enforce` switch to the tenant-validated path — the principal's tenant (session claim / `KdsDeviceToken.tenantId`) is read and the requested store is honored only if it belongs to that tenant (a cross-tenant store fails closed → 400), which also enables the within-tenant store switcher a session was denied before. See [docs/multi-location.md](../../docs/multi-location.md).

Do not:

- Hand-write client DTOs that should be generated from `packages/contracts`.
- Move provider tokens or provider API calls into `ios/` or `apps/kds-web`.
- Treat local edits or browser UI state as the source of truth.

## Environment

- `MULTITENANT_MODE` — multi-tenant enforcement mode (ADR-0818 Phase 2c), one of `off` (default) / `observe` / `enforce`. Gates the tenant-validated, fail-closed merchant resolution in `src/lib/kds-auth.ts`. `off` = today's behavior byte-for-byte (no tenant check, no extra query). `observe` = a dual-read parity window: compute the tenant-scoped resolution and log any divergence from legacy (scope `kds.tenant.parity`), but still RETURN the legacy result (zero behavior change — verify parity in Loki first). `enforce` = RETURN the tenant-scoped result and fail closed on a cross-tenant/unknown merchant. Not in Infisical — wired as a `${MULTITENANT_MODE:-off}` passthrough on **both** kds-api and kds-worker in `compose/kds.yml` (the default MUST be the non-empty `off`, since `z.enum(...).default("off")` rejects the empty string a bare `${VAR:-}` would inject), so flipping it is a host-env edit + `compose up` restart — no redeploy. Flip `off → observe → enforce` only after confirming parity, and set the SAME value on both services. (Once stores have distinct tenants this is the trust boundary; while both live stores are `tenant-default` the three modes resolve identically.)
- `AI_TOKEN_ENCRYPTION_KEY` — **required** for POS provider token at-rest encryption (Phase 4.5+). 32-byte hex (64 chars). Consumed by `src/lib/crypto/encryption.ts` in **kds-api only** (server + worker) — it encrypts the `*Cipher` columns in `clover_merchants`, `pos_accounts`, and `kds_provider_configs`. The backoffice's `app_setting` store uses a **separate** key (`APP_SETTING_ENCRYPTION_KEY`); the two are distinct so a leak of one never exposes the other. A **Layer-1 Infisical secret** (ADR-0020, amended 2026-06-18) injected by `with-infisical` from the Infisical `prod` scope, with a 1Password break-glass copy; declared as a `${AI_TOKEN_ENCRYPTION_KEY:-}` passthrough on kds-api + kds-worker in `compose/kds.yml`. Both entrypoints call `assertAiTokenEncryptionKey()` right after `loadConfig()` so a missing/malformed key fails **fast at boot** with a clear message instead of crash-looping inside the first encrypt (the 2026-06-18 incident). It is NOT a pre-Infisical bootstrap secret: the Prisma migrate sidecars run `prisma migrate deploy` and never read it, and the app reads it only after `with-infisical` injection.
- `CLOVER_SYNC_MAX_AGE_MINUTES` — how stale the most recent Clover sync may be before `/api/ready` reports `checks.cloverSync = "stale: …"` and logs a `kds.api.ready.clover` warning (GH #154). Default `90`. **Diagnostic only** — like `checks.cloverToken` it never flips the readiness `ok`/503 gate, so a Clover outage (operator-actionable) can't roll back an unrelated deploy. Optional; not in Infisical.
- `CLOVER_WEBHOOK_AUTH_CODE` — shared secret for the Clover webhook endpoints below. When set, the handler 401s any POST whose `X-Clover-Auth` / `X-Clover-Auth-Code` header doesn't match. **In production the webhook fails closed when this is unset** — anonymous POSTs are rejected 401 (GH #454), and a startup warning is logged. Outside production (dev / sandbox) it stays permissive when unset so local testing needs no secret. A Layer-1 Infisical secret (ADR-0020), injected into the container at startup by the `with-infisical` entrypoint.
- `INTERNAL_ANALYTICS_API_URL` + `KDS_ANALYTICS_PUSH_TOKEN` — the Square analytics token-push (Phase 4). After `/api/square/connect` persists a Square store, kds-api POSTs it as a sync target to analytics-api's `POST /admin/api/sync-targets` (URL = `INTERNAL_ANALYTICS_API_URL`, bearer = `KDS_ANALYTICS_PUSH_TOKEN`). The push is **best-effort + non-fatal** (a store is live for KDS regardless) and **never logs the token** (tokenLast4 only). Both optional → the push is a **no-op when unset** (local dev without analytics). `KDS_ANALYTICS_PUSH_TOKEN` is a dedicated bearer, scoped narrower than `ANALYTICS_ADMIN_TOKEN` (it unlocks only the sync-target route, not all of `/admin`); the same value lives on the analytics stack as `KDS_ANALYTICS_PUSH_TOKEN`. Infisical `dev`+`prod` root.

## Device pairing (ADR-0818 Phase 2b)

Floor devices (KDS boards, order-ready displays) pair **once via a link** and are then permanently scoped to their store — no login, no `?merchantId=` entry. Two-secret split:

- **Durable trust = `KdsDeviceToken`** (`yrkds_`, hash-stored, **no expiry — revoke-only**, `tenantId`-stamped). It's a DB credential, not a session, so it survives reboot / kds-api redeploy / WS reconnect. Only a manager **revoke** (`DELETE …/devices/:id`) or a full device storage wipe un-pairs it.
- **Short-lived claim code in front of it** — `src/lib/device-pairing.ts`: `createPairingClaim` writes a one-time envelope to Redis (`kdspair:<CODE>`, `EX PAIR_CLAIM_TTL_SECONDS`); `redeemPairingClaim` does an atomic `GETDEL` and only **then** mints the token + creates the row (so `tokenHash` is never null and no "pending" rows accumulate). Claim codes are Crockford base32 (`generateClaimCode`). The long-lived token **never** travels in a pairing URL — that would be the IDOR.

Routes: admin `POST /api/admin/kds/devices/pair` mints a claim (mirrors the device CRUD, `adminBearer`); public `POST /api/pair/redeem` lives in `src/routes/pairing.ts`, registered **outside** the `/api/kds/*` auth preHandler, per-IP rate-limited, and on success it `setCookie`s the durable token. All device creates stamp `tenantId` via `resolveTenantIdForMerchant`.

**Transport = a same-origin HttpOnly cookie, not a bearer.** kds-web and kds-api are both served from `kds.…` (Traefik routes `/api` + `/ws` → kds-api), so the `yr_device_token` cookie rides every board → kds-api HTTP call **and the WS handshake** automatically. `authenticateKdsRequest` reads `bearerToken(request) ?? request.cookies[DEVICE_TOKEN_COOKIE_NAME]` — additive; the session + bearer paths are unchanged. New env (both optional): `KDS_WEB_BASE_URL` (origin used to build the returned `pairUrl`), `PAIR_CLAIM_TTL_SECONDS` (claim TTL, default 600).

**Order-ready display** (`/api/display/tickets` + `/ws/display`) is staged behind `MULTITENANT_MODE` via `resolveDisplayMerchant` (the display-side analogue of `resolveKdsRequestMerchant`): `off`/`observe` keep the public `?merchantId=` kiosk path byte-for-byte (`observe` also logs a `kds.tenant.parity` divergence when a paired device is present); `enforce` requires the paired DISPLAY device token (it rides the same-origin cookie on the HTTP call AND the `/ws/display` upgrade) and rejects a mismatched `?merchantId=` — closing the untrusted-param IDOR. The display's `/api/kds/events` backfill already sits behind the `/api/kds/*` auth wall: a paired display's cookie makes it return 200 (proper incremental catch-up) instead of the public path's graceful 401→snapshot fallback.

## Clover token startup validation (GH #170)

On boot, `initializeAppServices` calls `validateCloverTokenAtStartup` (see `src/lib/clover-startup-validation.ts`), which resolves the default merchant and probes `GET /v3/merchants/{id}` with the configured token. The intent is fail-fast operator awareness: a stale/revoked token is surfaced at startup instead of waiting for the first sync job to fail. (Multi-location follow-up: today only the **default** merchant is probed; looping every active Clover-provider merchant — skipping Square `PosStore`s — is deferred. See [docs/multi-location.md](../../docs/multi-location.md).)

- It is **best-effort and non-fatal** — a Clover outage (or no merchant configured yet) must not block startup. A missing merchant reports `skipped`; a probe error reports `failed` but boot continues.
- Outcome is exported on the gauge `kds_clover_startup_validation_status{merchant}` (`1`=pass, `0`=fail) and folded into the `/api/ready` body under `checks.cloverToken` (`ok` / `skipped: …` / `failed: …`).
- `checks.cloverToken` is **diagnostic only** — it does NOT flip the readiness `ok`/503 gate, because a token an operator can re-auth in the Clover admin should never trigger a deploy rollback. Only Postgres + Redis gate readiness.

## Clover sync freshness on `/api/ready` (GH #154)

`/api/ready` also reports how fresh the live Clover sync is, so a stalled sync worker or a multi-hour Clover outage (no new tickets reaching the kitchen) stops showing green. The body adds `cloverLastSync` and `cloverLagSeconds`, plus a `checks.cloverSync` state: `ok`, `stale: <lag>s …` (when lag > `CLOVER_SYNC_MAX_AGE_MINUTES`), `never-synced`, `no-merchant`, or an error string.

- **Freshness keys on pipeline liveness, not just orders.** `cloverLagSeconds` is the time since the most recent of `lastSyncAt` (per synced order), `lastReconciledAt` (per *successful* reconciliation poll, ~every 45s), and `lastWebhookAt`. Keying on `lastSyncAt` alone false-flagged "stale" during any quiet period (e.g. an overnight closure with no orders), so it must use the max of the three. `lastReconciledAt` only advances after a successful Clover fetch (`reconciliation.ts`), so a genuine outage / bad token freezes all three and `cloverSync` correctly flags stale.

- Like `checks.cloverToken`, this is **diagnostic only** — it is computed *after* the `allOk` gate so a stale sync never flips the deploy-gating 503. Alert on it via Prometheus / log scraping (`scope: "kds.api.ready.clover"`), not via the readiness gate.

## Clover webhook endpoint (reference)

Two POST routes share one handler in `src/routes/clover.ts`:

- `POST /api/clover/webhooks` — primary
- `POST /webhooks/clover` — legacy alias

Handler behavior:

1. **Verification handshake**: if the body contains a top-level `verificationCode`, store it on the merchant's provider state and return `{ ok: true, verificationCodeReceived: true }`. Clover POSTs this once when the URL is first saved in the dashboard.
2. **Auth check**: if `CLOVER_WEBHOOK_AUTH_CODE` is set, the `X-Clover-Auth` (or `X-Clover-Auth-Code`) header must match or the request is rejected 401. **In production, an unset code rejects every (non-handshake) POST 401** rather than accepting anonymous webhooks (GH #454); dev / sandbox stay permissive when unset.
3. **Parse + enqueue**: `parseCloverWebhookEvents` normalizes batch and flat payloads into `CloverWebhookEvent`s; events are persisted via `createProviderEvents` and pushed to the provider-ingress queue (`enqueueProviderEvents`) for the normal sync pipeline.

### Enabling webhooks (when ready)

1. In the Clover Developer Dashboard, set the webhook URL to `https://<kds-host>/api/clover/webhooks`.
2. Store the dashboard's auth code in Infisical as `CLOVER_WEBHOOK_AUTH_CODE` (restaurant-ops-platform project, `dev` / `prod` env); the host `.env` holds only the Infisical machine-identity (secret-zero) that fetches it at container startup.
3. Subscribe to at least the `orders` event family. Save — Clover will POST a verification code; the dashboard will show "Verified ✓" once our handler stores it.

### HMAC signature verification (deferred — issue #119)

Webhook delivery is currently authenticated by `X-Clover-Auth` only (a shared-secret check). An earlier attempt at HMAC-SHA256 verification (#119, reverted in `248c5fa`) was based on an unverified assumption that Clover sends `x-clover-request-hmac-sha256`. Before any new attempt, confirm in the Clover Developer Dashboard whether the app exposes a "Signing secret" / "HMAC secret" field and which header carries the digest; bake that fact into the issue before reopening.
