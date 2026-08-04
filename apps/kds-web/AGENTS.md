# Web Agents

`apps/kds-web` owns the active Next.js Floor surfaces: login, board, customer display, and setup-passkey. It is an API client of `apps/kds-api`, not an integration hub. All admin UI now lives in `apps/backoffice-web` (Iron Law #4 — Floor vs Backoffice boundary).

Use these checks when relevant:

- `pnpm --filter @rop/kds-web build`
- `pnpm --filter @rop/kds-web test`
- `pnpm --filter @rop/kds-web lint`
- `pnpm --filter @rop/kds-web test:e2e` for browser-flow changes

Do:

- Import shared auth behavior through `@rop/auth` or the existing `src/lib/{auth,auth-client,server-auth}.ts` shims.
- Reuse shared contracts from `packages/contracts` for API-facing shapes.
- Keep browser state as presentation/cache over backend state.
- Preserve login/session and passkey flows when changing navigation.
- Preserve device pairing (ADR-0818 Phase 2b): `/pair?code=` (`PairScreen`) redeems a claim against kds-api and stores the same-origin `yr_device_token` cookie; `/board` then short-circuits on that cookie (`cookies()` check **before** `requireServerAuthSession`) and boots into the bound store with **no login**. Don't add a `?merchantId=` default for a paired board — the device's store comes from its token, resolved server-side. The customer `/display` mirrors this (`DEVICE_TOKEN_COOKIE_NAME` present → scope to the device's bound store; else the public `?merchantId=` kiosk fallback); a DISPLAY-role device pairs through the same `/pair` page (`PairScreen` redirects `role==="DISPLAY"` → `/display`). kds-api enforces the display's store from the token once `MULTITENANT_MODE=enforce`.
- Follow `docs/web-ui-testing-auth.md` when changing Web UI auth gates or running local browser UI review.
- Validate customer-display and board changes on mobile and large display widths when layout changes.

Do not:

- Put provider tokens, Clover/Deliverect API calls, or sync orchestration in the web app.
- Duplicate backend business rules that belong in `apps/kds-api`.
