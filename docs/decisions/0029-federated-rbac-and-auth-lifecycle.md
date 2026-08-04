# ADR-0029: Federated RBAC roles + auth lifecycle for the suite

- **Status**: Proposed
- **Date**: 2026-06-01
- **Deciders**: @example-org

> **Status note (2026-06-18):** Partially implemented. P1 landed (the `WebAdminRole` enum + `can()` helper + role vocabulary), but `can()` is currently wired only on the backoffice settings routes — **P3 enforcement** across kds-api / inventory-api crew routes and **P5 per-location role scoping** (a DB-level account→`Location` membership relation) are **not built**. There is no account→store allow-list yet, which is why a logged-in web session is pinned to the default merchant for KDS (see `apps/kds-api/src/lib/kds-auth.ts` `resolveKdsMerchantId`). Stays *Proposed* until P3/P5 land. See [docs/multi-location.md](../multi-location.md).

## Context

User / password / permission management across the suite had drifted into an
ad-hoc state:

- `web_admin_accounts` (db-auth) had a `WebAdminRole` enum with a **single**
  value, `ADMIN` — so every Backoffice / KDS login was structurally
  "full admin," with no role separation.
- The only password-mutation paths (`createAdminUser`,
  `resetAdminUserPassword` in `apps/kds-api`) issue a **random** one-time
  password. There is no way to set or change a *chosen* password, and no
  self-service change-password flow anywhere in `apps/kds-api` or
  `packages/auth`.
- Passkeys are positioned as the primary credential.
- Floor staff identities live in a **separate** store —
  `inventory_employees` (db-inventory), authenticated by PIN via
  `@rop/auth/crew` — with a free-text `role` string that gates nothing.

The operator runs the business with **2 owners** (full access incl.
financials, settings, AES-GCM-encrypted secrets) and **2 store staff** (KDS
shared board + crew inventory only).

A deep review of mature restaurant POS systems (Toast "Jobs", Square 4-digit
role-bound passcodes) and authentication standards (NIST SP 800-63B-4, OWASP
ASVS 5.0, OWASP cheat sheets) confirmed the target shape: one identity per
person, RBAC where a role is a named bundle of permissions, a short numeric
PIN bound to a role for shared terminals, and password (+ optional MFA) for
privileged accounts — with length-not-composition passwords, no forced
rotation, mandatory breach screening, and user-chosen resets.

## Decision

Adopt a **federated RBAC model**: a single shared role/permission *vocabulary*
and a single authoritative permission check, while leaving each identity in
the store that already owns it (owners in db-auth, staff in db-inventory).
This realizes "one account per person" in practice — owners and floor staff
are disjoint people — without a risky cross-database identity merge, and it
respects the Iron Laws as-is (inventory-api never imports db-auth; kds-api
never imports db-inventory).

### Roles & permissions

- Suite-wide `Role` = `OWNER | STAFF | MANAGER` (`MANAGER` reserved, not issued
  at MVP). Defined in `packages/contracts`.
- A granular `Permission` catalog (`inventory.waste.record`, `kds.ticket.act`,
  `analytics.read`, `settings.write`, `secrets.read`, `users.manage`, …) in
  `packages/contracts`.
- `ROLE_PERMISSIONS` map + `can(role, permission)` in `packages/auth/rbac` —
  pure, **db-free**, exported via the `@rop/auth/rbac` subpath so every
  surface (kds-api, backoffice, inventory-api, crew-web) shares one check
  without pulling a database client (the same decoupling as
  `@rop/auth/crew`).
- OWNER → full catalog. STAFF → operational-only (KDS board acts + crew
  receive / count / 86 / waste); explicitly **no** analytics / settings /
  secrets / users.

### Authentication

- **Owners**: argon2id password. Per OWASP/NIST — ≥15 chars (no MFA at launch),
  no composition rules, no forced rotation, breach-list screened, user-*chosen*
  resets (replacing the random-OTP path). Optional TOTP + step-up re-auth on
  the secrets/settings surface (phase P4). Passkeys demoted from primary to
  optional add-on.
- **Staff**: 6-digit PIN reusing the existing `crew-pin` primitives (argon2
  hash + keyed HMAC lookup index + stateless HMAC session), with PIN
  verification placed behind kds-api's Redis rate-limiter (per-account ceiling
  ≤100 consecutive failures per NIST, **adaptive backoff** — never a hard
  lockout that strands the line mid-service).

### Sessions

- Per-app session cookies scoped to each origin — never a permissive parent
  `Domain` across the KDS/crew/backoffice subdomains (OWASP: a permissive
  Domain lets an attacker pivot session IDs between apps).
- Rotate session ID on login; server-side invalidation for sign-out-everywhere.
  Admin sessions are **Redis-backed** (server-side revocable today). The
  stateless crew HMAC token is the one gap — a short TTL + revocation epoch is
  the planned strategy (phase P3/P5).

### Phased rollout

- **P1 (first slice)**: shared role/permission vocabulary + `can()` mechanism +
  db-auth `WebAdminRole` expansion (OWNER/MANAGER added; existing ADMIN rows
  migrated to OWNER; default → OWNER). Additive, **not yet enforced** — zero
  behavior change.
- **P2**: real owner password lifecycle (invite/first-login set, self-service
  change, user-chosen breach-checked reset) replacing OTP-only.
- **P3**: enforce `can()` across kds-api / backoffice / inventory-api crew
  routes; align `inventory_employees.role` to the shared enum; audit logging of
  who-did-what.
- **P4**: optional owner TOTP + step-up on secrets/settings + demote passkeys.
- **P5 (deferred)**: per-location role scoping for the multi-location roadmap.

## Consequences

- One authorization vocabulary and one `can()` for the whole suite; future
  roles/permissions are a single-file change.
- "One account per person" holds in practice without a cross-DB migration; the
  trade-off is that a single human who is *both* an owner and floor staff would
  have two rows — a non-issue for the current disjoint 2+2 population, revisited
  if that changes.
- Staff get no individual KDS login (KDS is a shared board by decision);
  per-person audit attribution remains where it matters (crew inventory
  actions, already keyed to the employee).
- Iron Laws upheld: `@rop/db-auth` import sites unchanged; `@node-rs/argon2`
  stays in `packages/auth`; the new `rbac` subpath is db-free; all new DTOs live
  in `packages/contracts`; the new enum values are recorded in `ARCHITECTURE.md`.

## Alternatives considered

- **Full identity unification** (single `accounts` table in db-auth, staff PINs
  migrated in, kds-api issues a role-bearing token that inventory-api verifies
  statelessly). The literal "one table" ideal and the cleanest path to
  staff-on-KDS individual login. Rejected for MVP: largest blast radius
  (re-home crew auth, cross-DB migration, re-point crew login) for marginal
  benefit at a 4-person scale where owners and staff are disjoint. Kept as the
  documented upgrade path if a person ever needs to span both classes or staff
  need individual KDS identity.
- **DB-driven permission catalog** (permissions / roles / role_permissions
  tables, Toast-style). Over-engineered for 2 roles and violates db-auth's
  "keep the schema minimal" guidance. The code-level catalog + map is
  sufficient and is trivially promotable later.
