import { z } from "zod";

import { WebAdminRoleSchema } from "./auth.js";

/**
 * Multi-tenant platform contracts (ADR-0818). A **Tenant** is the top-level trust
 * boundary — the paying business (Toast's "Management Group") — that contains
 * Locations, which host Devices. `tenant_id` is a hard wall (RLS key + token
 * claim, never client-supplied); `locationId` is a soft, relaxable partition key
 * *underneath* it. See docs/architecture/multi-tenant-architecture.md.
 *
 * Iron-Law-2 seam for the migration. Phase 1 landed the `Tenant` entity DTO + the
 * resolved per-request `TenantScope`. Phase 2 adds the DTOs that *consume* them
 * (still additive plumbing — no app reads them until the flagged session
 * rewrite): `TenantMembership` (mirrors the db-auth model), `TenantSessionClaim`
 * (the authenticated principal's tenant context, minted into the cookie session),
 * and `AnalyticsTenantClaim` (the signed payload analytics-api verifies instead of
 * trusting `?merchant_id=`).
 */

/**
 * The id of the single implicit tenant today (the owner's brand), seeded by the
 * Phase-1 backfill across every domain DB. Apps may stamp this on writes until a
 * real tenant context exists (Phase 2). It is NOT a fail-open fallback for a
 * *resolved request scope* — an unknown scope fails closed (403 / zero rows), per
 * the architecture's security model — only the additive single-tenant default.
 */
export const DEFAULT_TENANT_ID = "tenant-default";

/** Lifecycle state — mirrors the db-kds `TenantStatus` enum (keep in sync, Iron Law 2). */
export const TenantStatusSchema = z.enum(["ACTIVE", "SUSPENDED", "OFFBOARDING", "ARCHIVED"]);
export type TenantStatus = z.infer<typeof TenantStatusSchema>;

/** The tenant entity as a cross-app DTO (mirrors the db-kds `Tenant` model). */
export const TenantSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  slug: z.string(),
  status: TenantStatusSchema
});
export type Tenant = z.infer<typeof TenantSchema>;

/**
 * A principal's resolved scope WITHIN one tenant: the tenant trust boundary plus
 * the locations it may act on. `tenantId` is the hard wall; `locationIds` is the
 * soft, relaxable within-tenant filter. An **empty** `locationIds` means "every
 * location in the tenant" (Toast group-level access), NOT "no access" — the
 * no-access / fail-closed case is the *absence* of a `TenantScope` altogether,
 * never a present-but-empty one.
 */
export const TenantScopeSchema = z.object({
  tenantId: z.string().min(1),
  locationIds: z.array(z.string())
});
export type TenantScope = z.infer<typeof TenantScopeSchema>;

/**
 * A membership row: which tenant an admin account belongs to, and its role
 * there (the *tenant* axis of access). Field-for-field mirror of the db-auth
 * `TenantMembership` Prisma model (Iron Law 2 — keep in sync). `tenantId` is a
 * bare string: db-auth does not own the Tenant table. The role reuses the
 * db-auth account-role vocabulary (`WebAdminRoleSchema`), not the suite-wide
 * `RoleSchema`. Additive — `WebAdminAccount.role` stays the live source of truth
 * until the flagged session rewrite consumes memberships.
 */
export const TenantMembershipSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  tenantId: z.string().min(1),
  role: WebAdminRoleSchema
});
export type TenantMembership = z.infer<typeof TenantMembershipSchema>;

/**
 * The authenticated principal's tenant context: who they are, their role, and
 * their resolved `TenantScope`. This is what Phase 2 mints into the cookie
 * session (packages/auth) and every BFF reads. `scope` is the SAME
 * `TenantScopeSchema` — composed, never re-inlined — so the hard-wall invariant
 * (non-empty `tenantId`; absence-of-claim = fail closed, never `DEFAULT_TENANT_ID`)
 * has one definition.
 */
export const TenantSessionClaimSchema = z.object({
  accountId: z.string().min(1),
  role: WebAdminRoleSchema,
  scope: TenantScopeSchema
});
export type TenantSessionClaim = z.infer<typeof TenantSessionClaimSchema>;

/**
 * The signed payload analytics-api verifies (Phase 2, replacing the
 * `?merchant_id=`-behind-a-shared-token trust): the tenant plus the EXPLICIT set
 * of merchant ids it owns, so the read path intersects a requested `merchant_id`
 * against `merchantIds` server-side and 403s on a miss. `merchantIds` is required
 * (not optional) — an absent/permissive set would silently re-open the hole.
 * `iat`/`exp` are unix seconds for short-lived signing.
 */
export const AnalyticsTenantClaimSchema = z.object({
  tenantId: z.string().min(1),
  merchantIds: z.array(z.string()),
  iat: z.number().int(),
  exp: z.number().int()
});
export type AnalyticsTenantClaim = z.infer<typeof AnalyticsTenantClaimSchema>;
