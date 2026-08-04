# Web UI Testing Auth

This repo uses three different authentication modes for browser UI work. Keep them separate so local review stays fast without weakening production or E2E coverage.

The normal repo local dev loop runs the web app on port `3000`:

```bash
make dev-up   # first run: install, DBs, migrate, seed
make dev      # launch the stack
```

Open:

```text
http://127.0.0.1:3000/board
```

The `3030` port used later in this document is only for a manually launched, isolated UI-review server.

## Production

Production always uses the real browser auth flow:

- Password login and passkey login remain the only supported entry points.
- Do not enable `WEB_AUTH_DEV_BYPASS` in production, Docker deploys, or hosted staging environments that handle real merchant data.
- Do not add UI buttons, query params, magic links, or API routes that bypass auth.

## E2E And CI

Formal browser tests should use a seeded test admin and Playwright `storageState`.

The recommended shape is:

- Seed a deterministic test admin account for the test environment.
- Add a Playwright global setup that logs in once through the real login route.
- Save the browser state to `apps/web/.auth/admin.json`.
- Configure authenticated specs to use that `storageState`.
- Keep login and passkey specs separate so they still exercise the real auth surfaces.

This gives UI tests the same app behavior as production while avoiding repeated login work in every spec.

## Local Codex UI Review

When an AI agent or developer only needs to inspect layout, take screenshots, or validate board interactions locally, use the dev-only bypass:

```bash
WEB_AUTH_DEV_BYPASS=true \
INTERNAL_API_BASE_URL=https://kds.example.com \
NEXT_PUBLIC_API_BASE_URL= \
NEXT_PUBLIC_WS_BASE_URL=wss://kds.example.com \
NEXT_PUBLIC_DEFAULT_MERCHANT_ID=EXAMPLEMERCH1 \
pnpm --filter @rop/kds-web exec next dev --port 3030
```

Then open:

```text
http://127.0.0.1:3030/board
```

This command intentionally uses `3030` so it can run separately from the normal `pnpm dev` server on `3000`.

The bypass only works when `NODE_ENV=development`, which is what `next dev` uses. It only skips the Next.js server-side page gate for local UI review. It does not create a backend session, does not change API auth, and does not validate the login or passkey flows.

Keep `NEXT_PUBLIC_API_BASE_URL` empty for this local review mode. Browser HTTP calls and realtime stay same-origin on `127.0.0.1`, and the Next dev server proxies `/api/*` plus `/ws*` to `INTERNAL_API_BASE_URL`. Set `NEXT_PUBLIC_WS_BASE_URL` only when realtime should connect directly to a remote WebSocket host.

If the review needs real KDS data from an API that requires auth, do not rely on the bypass alone. Disable `WEB_AUTH_DEV_BYPASS`, sign in through the local `/login` route with the seeded test admin, or use the Playwright `storageState` flow described above. That keeps data-bearing tests on real session semantics.

## Rules For Future Agents

- Use the dev bypass only for local visual review and fast UI iteration.
- Use seeded login plus Playwright `storageState` for real E2E or CI coverage.
- If testing authentication, logout, passkey registration, or session expiry, do not use the bypass.
- If a change makes the bypass work in production, treat it as a security bug and fix it before merging.
