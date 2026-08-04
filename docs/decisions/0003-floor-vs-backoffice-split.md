# ADR-0003: Floor (kds-web) vs Backoffice (backoffice-web) split

- **Status**: Accepted
- **Date**: 2026-05-09 (Iron Law #4 codified in Phase 0); enforced structurally by Phase 4 closeout 2026-05-16
- **Deciders**: @example-org

## Context

Through 2026-04 and into early Phase 0, `kds-web` was the single browser-facing surface. It served three audiences off the same Next.js app:

1. **Kitchen staff** — board, display, login. iPad TVs mounted at the line. Must be visually quiet, refresh ≤ 2 seconds, tolerant of network blips.
2. **Operators / managers** — KDS device list, board settings, Clover token paste, daily reset config, user/passkey admin. Desktop or tablet, used a few times a week.
3. **(Briefly) owner analytics** — sales summaries, trend charts. Considered, never shipped here.

The admin surface accumulated as inline HTML inside Fastify route handlers in `kds-api/src/routes/admin.ts` (because it was easier than building a real Next.js page). By Phase 4 entry that file was **1490 lines of server-rendered HTML** including form posting, error rendering, and CSS.

Three forces pushed this into a problem:

- **UX mismatch.** Floor users want a board that stays out of the way. Admin users want dense tables, sortable columns, dialogs, command palettes. A single CSS aesthetic served neither well.
- **Refresh cadence mismatch.** Floor refreshes ticket data every few seconds via WebSocket. Admin pages are click-driven and can be 60-second stale. Sharing a routing tree forced both into the same patterns.
- **Auth scope mismatch.** Floor pages are accessible from kitchen tablets. Admin pages should *not* be a tap away on a kitchen tablet (a curious staffer could paste a new Clover token by accident). Co-locating them defeats path-based separation.

Then Phase 1 introduced `backoffice-web` as the analytics surface for owners. Two admin surfaces in parallel would be untenable. A decision was forced: which app owns the admin?

## Decision

**`apps/kds-web` is Floor-only.** Its sole responsibilities are board, customer display, login, passkey enrollment. No admin pages. No analytics pages.

**`apps/backoffice-web` is the sole admin surface.** Owner analytics, KDS device admin, Clover integration setup, daily reset config, user/passkey management — all of it lives here.

The split is codified as **Iron Law #4** in [`AGENTS.md`](../../AGENTS.md): "Don't conflate the two — different UX, different refresh cadence, different error tolerance."

Phase 4 (closing 2026-05-16) executed the migration in five sub-steps:

| Step | Surface | What moved into Backoffice |
|---|---|---|
| 4.1a | `/admin/devices` | KDS device list, registration tokens, revocation |
| 4.1b | `/admin/board` | Board settings (column layout, refresh interval, expediter mode) |
| 4.2 | `/admin/users` | Web admin accounts, passkey management (7 endpoints) |
| 4.3 | `/admin/integrations` | Clover token paste, token-mode selection |
| 4.4 | `/admin/reset` | Daily reset preview + manual trigger |
| 4.5 | (closeout) | Delete the 1490-line `kds-api/src/routes/admin.ts` HTML rendering. `kds.example.com/admin` now 301-redirects to `backoffice.example.com/admin/devices`. |

`kds-api` retained the JSON endpoints under `/api/admin/kds/*`. They are gated by bearer auth (`KDS_INTERNAL_ADMIN_TOKEN`). The HTML render is gone.

Service-to-service trust: `backoffice-web` calls `kds-api /api/admin/kds/*` with `Authorization: Bearer ${KDS_INTERNAL_ADMIN_TOKEN}`. Both sides must have the same value or all admin pages return `503 admin_not_configured`. See [`ARCHITECTURE.md` §5.2](../../ARCHITECTURE.md#52-service-to-service).

## Consequences

**Makes easy:**

- **Two design systems coexist without conflict.** `kds-web` keeps its custom CSS (paper / tomato / amber / mint / slate — kitchen-display aesthetic). `backoffice-web` runs Tailwind v4 + shadcn/ui + Modern Fintech tokens. Neither product apologizes for its choices.
- **Refresh cadence is per-app.** Floor uses WebSocket subscriptions. Backoffice uses TanStack Query with `staleTime: 60_000` against the BFF. Each is tuned to its data freshness needs.
- **Auth scope is hostname-separated.** A kitchen iPad bookmarked to `kds.example.com/board` can't accidentally fat-finger into admin pages — there are none on that host. Admin lives on `backoffice.example.com`, which kitchen tablets shouldn't have a passkey for.
- **Future Floor product additions go in `kds-web`; future admin/analytics in `backoffice-web`.** The decision tree for a new feature is one question, not three.

**Makes hard:**

- **Shared concerns now live in two places.** Both apps need cookie-session handling, both need login UI. We extracted the shared parts into `packages/auth` and `packages/contracts` (see Iron Laws #2, #3).
- **Admin pages have to round-trip through the BFF.** Backoffice → kds-api admin call is one extra hop vs. when admin was inline in `kds-api`. Latency is acceptable (10ms intra-host), but the indirection is real cognitive cost.
- **WebAuthn RP IDs are different.** A passkey registered on `kds.example.com` does **not** unlock `backoffice.example.com` and vice versa, unless the user registers separately or we accept SSO via shared parent domain (deferred — `WEBAUTHN_RP_ID` defaults to the exact subdomain). Operators must re-enroll a passkey on first Backoffice login.

**New risks:**

- The boundary requires discipline at PR time. A future "let's add a quick admin panel to kds-web for X" must be caught in review. The Phase 4 cleanup deleted 1490 lines specifically because this discipline lapsed before.

## Alternatives considered

- **Keep admin in `kds-web`.** This was the pre-Phase-4 state. Rejected because of the three mismatches (UX, refresh, auth scope) and because the inline-HTML approach was producing untestable monoliths in `kds-api/src/routes/admin.ts`.

- **Put admin in a third app `admin-web`** alongside `backoffice-web`. Rejected. Owner analytics and KDS admin share auth, share a sidebar shell, and are used by the same people. Splitting them creates two admin URLs to remember without functional benefit.

- **SSO across `kds.example.com` and `backoffice.example.com`** via shared parent domain (`example.com` as `WEBAUTHN_RP_ID`). Considered. Deferred — would require Cookie `Domain=example.com` instead of subdomain-only, broadening attack surface (any compromised subdomain reads the cookie). Single-merchant deployment can pay the "register passkey twice" cost. Revisit if user count grows.

## Related

- [ADR-0001: pnpm monorepo with four apps](./0001-pnpm-monorepo-with-four-apps.md) — the structure that allowed shipping `backoffice-web` next to `kds-web`.
- [ADR-0002: Five Iron Laws](./0002-five-iron-laws.md) — Iron Law #4 codifies this split.
- Phase 4 closeout — the full migration record.
