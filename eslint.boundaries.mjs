// Single source of truth for Iron Law boundary lint rules — see docs/decisions/0012.
//
// ESLint v9+ flat config resolves the *nearest* config to each file, so a rule in
// the root config does NOT reach apps that ship their own eslint.config.* (analytics-api,
// backoffice-web, crew-web). To enforce a boundary everywhere, the root config AND each
// per-package config import these helpers. ESLint rule options do NOT merge across
// flat-config blocks (last match wins), so each block composes the FULL restriction set
// via restrictedImports() rather than relying on inheritance.

export const argon2Path = {
  name: "@node-rs/argon2",
  message:
    "Iron Law #3 (auth boundary): password hashing lives in packages/auth. Import the auth service, never @node-rs/argon2 directly."
};

export const dbKdsPattern = (message) => ({
  group: ["@rop/db-kds", "@rop/db-kds/*"],
  message
});

export const dbAuthPattern = (message) => ({
  group: ["@rop/db-auth", "@rop/db-auth/*"],
  message
});

export const dbCrmPattern = (message) => ({
  group: ["@rop/db-crm", "@rop/db-crm/*"],
  message
});

export const dbNotificationsPattern = (message) => ({
  group: ["@rop/db-notifications", "@rop/db-notifications/*"],
  message
});

export const DB_AUTH_DEFAULT =
  "Iron Law #3 (auth boundary): @rop/db-auth lives behind packages/auth. Import @rop/auth or the BFF service factory, never @rop/db-auth directly. See ADR-0015.";

export const DB_CRM_DEFAULT =
  "Iron Law #1 (DB boundary): @rop/db-crm is the loyalty/CRM database client. Only apps/crm-api may import it; every other app calls crm-api over HTTP. See ADR-0021.";

export const DB_NOTIFICATIONS_DEFAULT =
  "Iron Law #1 (DB boundary): @rop/db-notifications is the notifications database client. Only apps/notifications-api may import it; every other app calls notifications-api over HTTP. See ADR-0801.";

// Default rule set: bans the password-hashing primitive (Law 3), the db-auth
// Prisma package (Law 3 via ADR-0015), the db-crm Prisma package (Law 1 via
// ADR-0021), AND the db-notifications Prisma package (Law 1 via ADR-0801 — only
// apps/notifications-api may import it). Callers add extra path / pattern
// restrictions (typically dbKdsPattern) where they apply.
export function restrictedImports(extraPaths = [], extraPatterns = []) {
  return [
    "error",
    {
      paths: [argon2Path, ...extraPaths],
      patterns: [
        dbAuthPattern(DB_AUTH_DEFAULT),
        dbCrmPattern(DB_CRM_DEFAULT),
        dbNotificationsPattern(DB_NOTIFICATIONS_DEFAULT),
        ...extraPatterns
      ]
    }
  ];
}

// Variant for files in the documented db-auth carve-outs:
//   - packages/auth/** (the entire shared auth package)
//   - apps/kds-api/src/lib/services.ts (BFF wiring point)
//   - apps/backoffice-web/lib/auth/** (BFF wiring point)
// Still bans argon2 (it is kept inside packages/auth itself) but allows
// @rop/db-auth. See ADR-0015.
export function restrictedImportsForDbAuthCarveOut(extraPaths = [], extraPatterns = []) {
  return [
    "error",
    {
      paths: [argon2Path, ...extraPaths],
      patterns: [
        dbCrmPattern(DB_CRM_DEFAULT),
        dbNotificationsPattern(DB_NOTIFICATIONS_DEFAULT),
        ...extraPatterns
      ]
    }
  ];
}

// Variant for apps/crm-api/**: the loyalty/CRM service is the ONE place that may
// import @rop/db-crm (Iron Law 1, ADR-0021), so dbCrmPattern is omitted.
// Still bans argon2 (Law 3) and @rop/db-auth (Law 3 via ADR-0015) — crm-api
// has no business in password hashing or the auth tables.
export function restrictedImportsForDbCrmCarveOut(extraPaths = [], extraPatterns = []) {
  return [
    "error",
    {
      paths: [argon2Path, ...extraPaths],
      patterns: [
        dbAuthPattern(DB_AUTH_DEFAULT),
        dbNotificationsPattern(DB_NOTIFICATIONS_DEFAULT),
        ...extraPatterns
      ]
    }
  ];
}

// Variant for apps/notifications-api/**: the notifications service is the ONE
// place that may import @rop/db-notifications (Iron Law 1, ADR-0801), so
// dbNotificationsPattern is omitted. Still bans argon2 (Law 3), @rop/db-auth
// (Law 3 via ADR-0015), and @rop/db-crm (Law 1 via ADR-0021).
export function restrictedImportsForDbNotificationsCarveOut(extraPaths = [], extraPatterns = []) {
  return [
    "error",
    {
      paths: [argon2Path, ...extraPaths],
      patterns: [dbAuthPattern(DB_AUTH_DEFAULT), dbCrmPattern(DB_CRM_DEFAULT), ...extraPatterns]
    }
  ];
}

export const DB_KDS_ANALYTICS =
  "Iron Law #1/#5: analytics-api owns its own analytics Postgres (raw SQL) and must never import the KDS Prisma client. It is read-only OLAP; data arrives via Clover webhooks, not a shared DB client.";
export const DB_KDS_KDSWEB =
  "Iron Law #1/#4: kds-web is a Floor frontend that talks to kds-api over HTTP/WebSocket. It must not import the KDS database client.";
export const DB_KDS_BACKOFFICE =
  "Iron Law #1/#5: backoffice-web may touch postgres-kds only via the documented lib/ai exception (ADR-0011). The auth tables now live in @rop/db-auth (ADR-0015). Never read or write KDS business tables from backoffice — call kds-api instead.";
export const DB_KDS_CREWWEB =
  "Iron Law #1/#4: crew-web is a Floor prototype. It must not import the KDS database client; it will talk to a backend over HTTP when one exists.";
export const DB_KDS_ORDERWEB =
  "Iron Law #1/#4: order-web is a customer-facing ordering frontend. It must not import the KDS database client; it talks to the ordering API over HTTP (mocked until the backend lands).";
