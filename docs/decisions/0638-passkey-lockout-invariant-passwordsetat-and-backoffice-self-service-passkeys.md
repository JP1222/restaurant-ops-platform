# ADR-0638: Passkey lockout invariant, passwordSetAt, and backoffice self-service passkeys

- **Status**: Proposed
- **Date**: 2026-06-13
- **Deciders**: @example-org

## Context

[ADR-0029](0029-federated-rbac-and-auth-lifecycle.md) set the auth lifecycle
target: passwords become real (chosen, breach-screened, user-reset) and
passkeys are an optional add-on, all behind `packages/auth` per Iron Law #3.
[ADR-0015](0015-extract-auth-tables-into-db-auth-package.md) made
`@rop/db-auth` the schema owner for `WebAdminAccount` /
`WebAuthnCredential` and pinned the import sites that may touch it.

Wiring the Backoffice Profile panel against that model surfaced three gaps:

1. **No lockout safety net.** Nothing stopped an account from removing its
   last credential. An owner could delete their only passkey while their
   `passwordHash` was still the random creation placeholder (never redeemed
   into a *chosen* password), and lock themselves out. Worse, the system had
   no notion of "keep at least one OWNER" — the last owner could in principle
   be demoted or stripped of login, leaving the suite with no one who can
   manage users or reach the secrets/settings surface.

2. **"Has a real password" was not representable.** `WebAdminAccount.passwordHash`
   is non-nullable. Per ADR-0029 every account is created with a *random*
   one-time hash and is expected to redeem it via a setup-link into a chosen
   password. But a populated `passwordHash` is indistinguishable between
   "never redeemed placeholder" and "real chosen password" — so a lockout
   guard built on "is `passwordHash` set?" would wrongly count the placeholder
   as a usable login method.

3. **No self-service passkey management in Backoffice.** `apps/kds-api` has a
   passkey register/list/delete surface, but it is **KDS-session-gated** and
   **not proxied** to Backoffice — a Backoffice user authenticated by the
   Backoffice cookie session cannot reach it. The Profile panel needs inline
   passkey register / list / delete in the *Backoffice* session domain.

The Profile panel scope also had aspirational rows with no backend: an Email
row (the suite has **no email channel** — sign-in is by username, and
ADR-0029's recovery is a *manually* issued setup-link, not an emailed token),
a "Change photo" button, and a "Sign out everywhere" affordance (no
revoke-all backend exists).

## Decision

### Lockout invariants (enforced in `packages/auth`)

Two invariants, checked server-side before any credential- or role-mutating
operation:

1. **Every account keeps ≥1 *usable* login method** — a *real* password
   (redeemed, see below) **or** ≥1 registered passkey. The last usable method
   cannot be removed.
2. **The system keeps ≥1 OWNER** — the last OWNER cannot be demoted, deleted,
   or stripped of its last login method.

The recovery path is unchanged from ADR-0029: when an account *is* locked out
(e.g. forgot password, lost passkey), an **OWNER issues a reset setup-link**
via the existing reset path. There is no self-service "I'm locked out"
recovery and no email channel — recovery is an owner action, by design at
single-merchant 2-owner scale.

The mechanism is a `countUsableLoginMethods(accountId)` helper in
`packages/auth/src/server/**`, surfaced through `createWebAuthService`.
"Has a usable password" = `passwordSetAt IS NOT NULL`; usable methods =
`(passwordSetAt ? 1 : 0) + passkeyCount`. A delete/demote is refused when it
would drop an account below 1 usable method, or drop the OWNER count below 1.

### Detection: a new nullable `passwordSetAt` column

Add `passwordSetAt DateTime?` to `WebAdminAccount` (db-auth). `NULL` =
creation placeholder / never-redeemed; non-NULL = a chosen password is in
force. It is stamped the moment a user redeems a setup-link or changes their
password (the existing `password/change` path), and cleared (back to NULL) if
a reset re-issues a placeholder. `countUsableLoginMethods` reads it.

This was chosen over two alternatives (see below): it is **additive** (a new
nullable column, no backfill semantics that can be wrong — existing rows read
as NULL = "not yet redeemed," which is the safe/correct default for the
random-OTP accounts ADR-0029 describes), **lower-risk** (no change to the
non-nullable `passwordHash` contract that the verify path depends on), and
requires **no read-path changes** (the login/verify flow still reads
`passwordHash` exactly as before; `passwordSetAt` is consulted only by the
lockout guard, never by authentication itself).

### A second, Backoffice-domain self-service passkey surface

A **new** self-service passkey register/list/delete surface now exists in the
Backoffice session domain, **parallel to** the kds-api one. This is
deliberate, not duplication-by-accident: kds-api's surface is gated on a
**KDS** session and is **not proxied** to Backoffice, so it is unreachable for
a Backoffice-cookie-authenticated user. The new surface lives behind
`apps/backoffice-web/lib/auth/**` and is exposed via Backoffice BFF routes
that mirror the existing `apps/backoffice-web/app/api/auth/password/change`
wiring: the route handler calls into `lib/auth/**`, and **only** `lib/auth/**`
touches `@rop/db-auth` / argon2 — never the route handler directly
(Iron Law #3). The shared invariant logic (`countUsableLoginMethods`,
`passwordSetAt`) lives once in `packages/auth/src/server/**` and is consumed
by both surfaces — kds-api through `admin-user-service.ts` / `services.ts`,
Backoffice through `lib/auth/**` — so the lockout guard cannot diverge between
the two entry points.

### Profile panel scope (the real subset only)

The Backoffice Profile panel wires **only** what has a real backend:

- inline passkey **register / list / delete** (the new Backoffice surface),
- self-edit of **displayName**,
- a real **read-only Role badge** and a real **passkey count**.

Role is **read-only** in Profile — changing roles is a manage-others / RBAC
concern (ADR-0029), not self-service, and is also where invariant #2 (keep ≥1
OWNER) is enforced.

**Removed entirely:** the **Email row** (no email column, no contract field,
no input anywhere — the suite has no email channel; sign-in is by username and
recovery is ADR-0029's manual setup-link), the **"Change photo"** button, and
the **"Sign out everywhere"** affordance (no revoke-all backend exists; adding
the affordance without the backend would be a lie in the UI).

### Deliberate test-contract changes

Two existing test contracts change *on purpose*, and reviewers should expect
the diff:

- **`admin-bearer-routes` `last_admin` tests** — updated to assert the new
  invariants: the last OWNER (and the last usable login method) cannot be
  removed via the bearer surface.
- **`auth-routes` self-service delete test** — the previously *conditional*
  passkey-delete assertion becomes **unconditional**: self-service delete is
  always allowed *except* when it would violate invariant #1, which the new
  guard now enforces uniformly.

## Consequences

- A user can no longer strand themselves: every mutation that could remove the
  last login method or the last OWNER is refused at the service layer, with
  the OWNER-issued setup-link as the sanctioned recovery.
- `passwordSetAt` gives the suite a first-class, queryable notion of "this
  account has redeemed a real password," distinct from the random creation
  placeholder — useful beyond the lockout guard (e.g. surfacing "pending
  first login" accounts later).
- There are now **two** self-service passkey surfaces (kds-api, Backoffice).
  They share the invariant core in `packages/auth`, but the route/BFF layer is
  duplicated by session domain. Acceptable: the alternative (proxy kds-api's
  KDS-gated surface into the Backoffice session) crosses session domains for
  no benefit. If a third surface ever needs it, promote the BFF shape into a
  shared helper — but the *db-auth/argon2 work stays in `packages/auth` and
  the per-app `lib/auth/**`*.
- **Revoke is transactional and shared across all three surfaces.** The
  manage-others path (`revokeAdminUserPasskey`) and both self-service surfaces
  route every passkey deletion through one helper — `deletePasskeyGuarded`
  (`packages/auth`) — which runs existence-check → lockout re-read → delete
  inside a single Serializable transaction with a bounded P2034/40001 retry.
  This closes the check-then-act TOCTOU on the last-login-method invariant and
  reconciles surface ordering so a stale/foreign credential id is always a 404,
  never a lockout status (409/422) masking it. `deleteAdminUser` carries the
  same Serializable + retry treatment. (Hardens the LOW-severity revoke items
  deferred from this work's adversarial review.)
- Iron Law #3 holds: `passwordSetAt` / `countUsableLoginMethods` live in
  `packages/auth/src/server/**`; kds-api consumes via
  `admin-user-service.ts` / `services.ts`; Backoffice consumes via
  `lib/auth/**`; no route handler imports `@rop/db-auth` or argon2
  directly. `WebAdminAccount` gains a column (not a new model), so the
  `check-doc-drift.sh` model inventory is unchanged; the column is documented
  in `ARCHITECTURE.md` by the schema-owning layer.
- The Profile panel is honest: every control maps to a real backend. The cost
  is a smaller panel than the original mock (no email, photo, or
  sign-out-everywhere), revisited only if/when a real backend for any of them
  lands.

## Alternatives considered

- **Make `passwordHash` nullable** (NULL = no usable password). Cleanest
  conceptually, but it is a **breaking change to a non-nullable column the
  verify path reads directly** — every read site must now handle NULL, raising
  the chance of a verify-path regression that fails *open* or *closed*
  incorrectly. The additive `passwordSetAt` flag achieves the same detection
  with zero read-path risk. Rejected.
- **Sentinel placeholder hash** (a known constant `passwordHash` value meaning
  "never redeemed"; treat it as "no usable password"). Keeps the column
  non-nullable but smears a *semantic* signal into the *credential* field —
  the verify path would have to special-case the sentinel, and any future
  argon2 parameter change could accidentally collide with or invalidate the
  sentinel. Fragile and surprising. Rejected in favor of an explicit column.
- **Do nothing (no lockout guard).** Status quo: a user can delete their last
  credential or the last OWNER can be removed, with no recovery short of a DB
  edit. Unacceptable for an owner-operated suite where the operator *is* the
  only OWNER. Rejected.
- **Proxy kds-api's passkey surface into Backoffice** instead of a second
  surface. Would avoid the duplicated BFF layer, but requires bridging a
  KDS-gated session into the Backoffice session domain — crossing a session
  boundary (the per-origin cookie scoping ADR-0029 deliberately keeps
  separate) for no real benefit. Rejected; the shared invariant core in
  `packages/auth` already prevents the logic from diverging.
- **Keep the full mock Profile panel** (email, change-photo, sign-out-
  everywhere as inert/stub controls). Rejected — a control with no backend is
  a UI lie and accrues "why doesn't this work?" debt. Wire the real subset;
  add the rest when its backend exists.
