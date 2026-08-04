# Auth Agents

`packages/auth` is the shared auth package for the suite. Phase 1 Step 1 completed the Strangler Fig migration: KDS API server auth, KDS web client/Next helpers, and Backoffice auth all consume this package.

It owns or will own:

- WebAuthn / passkey registration + authentication
- Argon2id password fallback
- Cookie session helpers (Fastify + Next.js Route Handler adapters)
- Postgres-backed session storage with rotation
- Internal-API JWT signing for cross-service trust

Current status:

- `src/server/*` contains KDS API server auth: sessions, WebAuthn flow storage, passkey credential persistence helpers, password verification, rate limiting, cookie option helpers, plus shared pure helpers and types.
- `src/client/*` contains browser-safe auth API fetch wrappers, passkey support/error helpers, and dev-auth bypass detection.
- `src/next/*` contains Next.js server helpers for cookie-forwarded session and passkey reads.
- `src/shared/*` contains app-safe auth session types and return-to navigation helpers.
- `src/server/crew-pin.ts` is self-contained crew PIN auth for shared floor devices (argon2 PIN hash/verify, a keyed PIN lookup index, and stateless HMAC-signed crew session tokens). It depends only on `node:crypto` + `./password.js`, and is exported via the `@rop/auth/crew` subpath so `apps/inventory-api` consumes it without pulling in the db-kds-coupled session modules (Iron Law 1). Do not add db/Redis imports to this file.
- Password login rate limiting (`src/server/rate-limit.ts`) tracks three Redis counters per failed attempt; a login is blocked when **any** cap is hit, and a 429 reports the longest applicable `retryAfterSeconds`. Successful login clears all three for that ip/account:
  - `auth:password-rate:<ip>:<username>` — combined ip+username, 5 failures / 15 min.
  - `auth:password-rate-account:<username>` — per account, 10 failures / hour (stops rotating-IP attacks on one account).
  - `auth:password-rate-ip:<ip>` — per IP, 30 failures / hour (stops one IP iterating many usernames). Safe because the admin account list is brand-global and fixed (both owner accounts; multi-location adds stores, not new login identities — see [docs/multi-location.md](../../docs/multi-location.md)), not an open-signup surface.
- Passkey assertion rate limiting (`src/server/rate-limit.ts`) keys a single counter by IP only — usernameless WebAuthn means there is no account to bucket on before verification. `auth:passkey-rate-ip:<ip>` allows 5 failed assertions / 15 min; the `options` and `verify` endpoints (backoffice BFF + kds-api Fastify) return 429 with a `Retry-After` header when blocked, and a successful verification clears the counter.
- KDS API consumes server auth through `apps/kds-api/src/lib/web-auth.ts`.
- KDS web consumes client/Next auth through `apps/kds-web/src/lib/{auth,auth-client,server-auth}.ts` compatibility shims.
- Backoffice consumes auth through BFF Route Handlers under `apps/backoffice-web/app/api/auth/*`.

Use these checks when relevant:

- `pnpm --filter @rop/auth build`
- `pnpm --filter @rop/auth typecheck`
- `pnpm --filter @rop/auth lint`
- `pnpm --filter @rop/auth test`
- `pnpm --filter @rop/auth test:integration`  # real ephemeral Postgres via Testcontainers (Docker); see [docs/TESTING.md](../../docs/TESTING.md)

Do NOT change DB, Redis, HTTP, cookie adapter, or route-handler behavior casually. These pieces have production auth constraints (session rotation policy, rate limiting, WebAuthn challenge storage, and cross-service trust) and must preserve KDS behavior unless the human explicitly approves a behavior change.
